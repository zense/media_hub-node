// Client makes the request

import Net from "net";
import Dgram from "dgram";
import * as Fs from "fs";
import Winston from "winston";
import * as Util from "util";
import { get as http } from "http";
import { URL } from "url";
import * as Path from "path";

import {
    DEFAULT_CLIENT as DEFAULT,
    DEFAULT_UDP_PORT,
    DEFAULT_NETWORK,
    DEFAULT_MULTICAST,
    DEFAULT_HTTP_PORT
} from "../utils/constants";

const logger = Winston.loggers.get("client");
const fstat = Util.promisify(Fs.stat);
const fsaccess = Util.promisify(Fs.access);
const mkdir = Util.promisify(Fs.mkdir);

// Function that actually downloads file served at url to given path. No check
// performed for path or callback to make it efficient. Error if path already
// exists.
// All check done by Client member functions.
// Params:
//  - url: URL at which file is served.
//  - path: Path to which file should be saved. Can be directory or file path.
//  - pathIsDir: True if path is a directory. In this case the name is set from
//  response header.
//  - callback: callback is sent bytes downloaded, file size and path as
//  arguments
function _download(url, path, pathIsDir, callback) {
    return new Promise((resolve, reject) => {
        let req = http(url);
        req.on("error", err => {
            // On request error
            reject(err);
        }).on("response", res => {
            if (res.statusCode !== 200) {
                logger.debug(
                    `_download: Server responded with ${res.statusCode}: ${
                        res.statusMessage
                    }`
                );
                reject(
                    `Server responded with ${res.statusCode}: ${
                        res.statusMessage
                    }`
                );
            }
            if (pathIsDir) {
                let fileName = res.headers["content-disposition"];
                // Extract filename from header. Assumption is that the
                // header is exactly as returned by the http service.
                // Might throw errors for other headers
                fileName = fileName.replace(`inline; filename="`, "");
                // Remove trailing double quote
                fileName = fileName.slice(0, fileName.length - 1);

                path = Path.join(path, fileName);
            }

            let fileSize = parseInt(res.headers["content-length"], 10);
            let bytesDownloaded = 0;

            // Do no overwrite existing file
            let downloadedFile = Fs.createWriteStream(path, {
                flags: "wx"
            });

            // If file exists or some unexpected error
            downloadedFile
                .on("error", err => {
                    // Abort HTTP request and unpipe response
                    req.abort();
                    res.unpipe(downloadedFile);

                    logger.debug(`_download: ${err}`);

                    if (err.code === "EEXIST") reject(`${path} already exsits`);
                    else reject(err);
                })
                .on("open", err => {
                    // add event handlers to res only after file has been
                    // successfully opened. This ensures that callback is
                    // called only if writeStream opened successfully
                    res.on("data", chunk => {
                        bytesDownloaded += chunk.length;
                        try {
                            // Don't stop download due to callback errors
                            callback(bytesDownloaded, fileSize, path);
                        } catch (err) {
                            logger.debug(`_download: ${err}`);
                            logger.debug(`_download: ${err.stack}`);
                        }
                    });

                    // Pipe data
                    res.pipe(downloadedFile);
                })
                .on("finish", () => {
                    resolve(path);
                });
        });
    });
}

// Function that actually downloads the entire directory. No check is performed
// for path, url or callback. Error if can't write to path.
// All checks done Client member functions.
// Params:
//  - url: URL of parent directory
//  - path: Path to parent directory
//  - callback: callback is sent bytes downloaded, file size and path as
//  arguments
async function _downloadDir(url, path, callback) {
    let req;
    let res = await new Promise((resolve, reject) => {
        // extremely minimal error handling in case it is not directory URL
        req = http(url, res => {
            let data = "";

            if (res.statusCode !== 200) {
                logger.debug(
                    `_downloadDir: Server responded with ${res.statusCode}: ${
                        res.statusMessage
                    }`
                );
                reject(
                    `Server responded with ${res.statusCode}: ${
                        res.statusMessage
                    }`
                );
            }

            res.on("data", chunk => {
                data += chunk;
            }).on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject("Corrupted response");
                }
            });
        }).on("error", err => {
            // Error on request object, returned by http
            logger.debug(`Client._downloadDir: ${err}`);
            reject("Error connecting to server.");
        });
    }).catch(err => {
        // If previous promise has been rejected then req might not have been
        // aborted.
        if (req) req.abort();
        throw err;
    });

    let childDownloadPromise = [];
    let origin = new URL(url).origin;

    for (let child of res.children) {
        if (child.type === "file") {
            // If file download file
            childDownloadPromise.push(
                _download(
                    `${origin}/${child.id}`,
                    Path.join(path, child.name),
                    false,
                    callback
                )
            );
        } else {
            // If directory, create directory and then download directory
            let childPath = Path.join(path, child.name);

            childDownloadPromise.push(
                mkdir(childPath).then(() => {
                    return _downloadDir(
                        `${origin}/${child.id}`,
                        childPath,
                        callback
                    );
                })
            );
        }
    }

    return Promise.all(childDownloadPromise);
}

export default class Client {
    // Params:
    //  An object consisting of the following options:
    //   - port: The port to which the client should bind to.
    //   - udpPort: The port of UDP server to which requests should be sent
    //   - httpPort: The port of the HTTP server for making requests
    //   - network [optional]: The network to which requests should
    //   belong. Default is "Media_Hub".
    //   - broadcastIp [optional]: The IP address to which broadcasts will
    //   be made. Default value is "255.255.255.255".
    //   - timeout [optional]: The time to listen for responses to udp
    //   requests. Default value is 3 seconds
    //   - useBroadcast [optional]: Use broadcast instead of multicast
    //   - mcAddr [optional]: Mutlicast address.
    //   - incoming [optional]: The default incoming directory for files. If
    //   not given path must be provided when downloading.
    constructor({
        clientPort: port = DEFAULT.port,
        udpPort = DEFAULT_UDP_PORT,
        httpPort = DEFAULT_HTTP_PORT,
        network = DEFAULT_NETWORK,
        broadcastIp = DEFAULT.broadcastIp,
        timeout = DEFAULT.timeout,
        useBroadcast = DEFAULT.useBroadcast,
        mcAddr = DEFAULT_MULTICAST,
        incoming
    }) {
        if (incoming) {
            try {
                // check if incoming is valid directory
                let incomingStat = Fs.statSync(incoming);
                if (!incomingStat.isDirectory()) {
                    throw Error(
                        "Client: Incoming is not a directory. It will be ignored"
                    );
                }
            } catch (err) {
                logger.debug(`Client: ${err}`);
                incoming = null;
            }
        }
        if (useBroadcast) {
            logger.debug(
                "Client: useBroadcast is true. Will send only broadcast messages."
            );
        }
        if (!Net.isIPv4(mcAddr)) {
            logger.debug(
                "Client: mcAddr is not of IPv4 type. Will send only broadcast messages."
            );
            useBroadcast = true;
        }

        this.port = port;
        this.udpPort = udpPort;
        this.httpPort = httpPort;
        this.network = network;
        this.broadcastIp = broadcastIp;
        this.timeout = timeout;
        this.incoming = incoming;

        // If broadcast requests have to be sent override broadcastIp
        // Thus useBroadcast and mcAddr are not stored
        if (!useBroadcast) {
            logger.debug(
                `Client: Will send multicast search requests to ${mcAddr}`
            );
            this.broadcastIp = mcAddr;
        }
    }

    // Broadcast search request
    // Params:
    //  - searchString: The string to search for
    //  - param [optional]: Search for name or tag. Empty implies no data
    //  will be sent to server.
    //
    //  Return Value:
    //   A Promise that is resolved to the results of the search
    search(searchString, param) {
        return new Promise((resolve, reject) => {
            if (typeof searchString !== "string") {
                logger.debug(
                    `Client.search: searchString is of type ${typeof searchString}`
                );
                reject("searchString should be of type string");
            }

            let request = {
                network: this.network,
                search: searchString,
                param: param || "default"
            };

            let requestString = JSON.stringify(request, null, 0);

            // Accumulate results from all responses in array
            let resultAcc = [];

            // Create UDP4 socket with reuseAddr
            // Socket is created for every search request for lack of better
            // alternative
            let socket = Dgram.createSocket("udp4", true);
            // Add event listeners to handle response
            socket
                .on("error", err => {
                    logger.error(`Client.search: ${err}`);
                    logger.debug(`Client.search: ${err.stack}`);

                    // Rejected if socket error occurs. Mainly if address is
                    // already used
                    reject(err);
                })
                .on("message", (mssg, rinf) => {
                    try {
                        let response = JSON.parse(mssg);
                        if (
                            response.network === request.network &&
                            response.search === request.search &&
                            response.param === request.param
                        ) {
                            let url = `http://${rinf.address}:${this.httpPort}`;

                            // Add results to responseAcc
                            response.results.forEach(result => {
                                resultAcc.push({
                                    name: result[0],
                                    url: `${url}/${result[1]}`
                                });
                            });
                        }
                    } catch (err) {
                        logger.debug(`Client.search.socketMessage: ${err}`);
                    }
                })
                .on("close", () => {
                    logger.debug("Client.search: Search socket closed");

                    // Resolve promise to result
                    resolve(resultAcc);
                });

            socket.bind(this.port, () => {
                // Set broadcast
                socket.setBroadcast(true);

                // Max number of hops is 128
                socket.setTTL(128);
                socket.setMulticastTTL(128);

                let addr = socket.address();
                logger.debug(
                    `Client.search: search request for ${request.search}:${
                        request.param
                    } sent via ${addr.address}:${addr.port} to ${
                        this.broadcastIp
                    }:${this.udpPort}`
                );

                // Send request via socket
                socket.send(requestString, this.udpPort, this.broadcastIp);

                // Add timeout for listening to responses
                setTimeout(() => {
                    logger.debug(
                        `Client.search: ${
                            this.timeout
                        } elapsed since search request. Timeout for response.`
                    );
                    socket.close();
                }, this.timeout);
            });
        });
    }

    // Download file
    // Params:
    //  - url: URL of file to be downloaded.
    //  - path [optional]: Path to save file. Can be name of file or directory. If not
    //  given will be saved to incoming.
    //  - callback [optional]: Called when progress is updated. The bytes
    //  downloaded, file size and path where file is downloaded will be passed
    //  as arguments.
    async downloadFile(url, path, callback) {
        let pathIsDir = false;

        // If path is passed check validity. After the if block if path or it's
        // parent directory is valid then it is not falsy
        if (path) {
            try {
                let stat = await fstat(path);

                // if path is directory we are done
                if (stat.isDirectory()) {
                    pathIsDir = true;
                } else if (stat.isFile()) {
                    // If a file exists at path then thow Error
                    throw Error(`File exists at ${path}`);
                }
            } catch (err) {
                try {
                    // path does not exist. Maybe it's the final path of the
                    // new file.  Check if parent directory exists.
                    if (err.code === "ENOENT") {
                        // Promise is rejected if parent directory doesn't exist
                        let stat = await fstat(Path.dirname(path));

                        // if parent directory exists then ok
                        if (!stat.isDirectory()) {
                            throw Error("Invalid path passed");
                        }
                    } else {
                        // If error is not ENOENT then rethrow
                        throw err;
                    }
                } catch (err) {
                    logger.debug(`Client.downloadFile: ${err}`);
                    // If parent directory does not exist, or if stat for path
                    // throws an error other than ENOENT then assign path to
                    // falsy value
                    path = null;
                }
            }
        }

        // If path is falsy then try incoming
        if (!path) {
            path = this.incoming;
            pathIsDir = true;
        }

        // If callback is not function, ignore silently
        if (typeof callback !== "function") {
            logger.debug(
                `Client.downloadFile: callback is of type ${typeof callback}. Ignoring callback.`
            );
            // assign callback to empty function
            callback = () => {};
        }

        // If path is falsy then incoming nor path passed is valid
        if (!path) {
            logger.debug(
                "Client.downloadFile: No valid incoming or path given."
            );
            throw Error("No valid incoming or path given.");
        }
        if (!url) {
            logger.debug("Client.downloadFile: URL not given.");
            throw Error("URL not given.");
        }

        try {
            // Now path has been set
            // Make request
            return await _download(url, path, pathIsDir, callback);
        } catch (err) {
            logger.debug(`Client.downloadFile: ${err}`);
            throw err;
        }
    }

    // Download directory
    // Params:
    //  - url: URL of directory to be downloaded.
    //  - path [optional]: Path to save file. Can be name of file or directory. If not
    //  given will be saved to incoming.
    //  - callback [optional]: Called when progress is updated. The bytes
    //  downloaded, file size, path for which information is given and a boolean
    //  value which is true if the path is that of the root directory is passed.
    //  as arguments.
    async downloadDirectory(url, path, callback) {
        let pathIsParent = false;

        // After the if block path is null only if path is not an existing
        // directory or dirname of path is not an existing directory
        if (path) {
            try {
                let stat = await fstat(path);

                // if path is directory we are done
                if (stat.isDirectory()) {
                    pathIsParent = true;
                } else if (stat.isFile()) {
                    // If a file exists at path then thow Error
                    throw Error(`File exists at ${path}`);
                }
            } catch (err) {
                try {
                    // path does not exist. Maybe it's the final path of the
                    // new directory.  Check if parent directory exists.
                    if (err.code === "ENOENT") {
                        // Promise is rejected if parent directory doesn't exist
                        let stat = await fstat(Path.dirname(path));

                        // if parent directory exists then ok
                        if (!stat.isDirectory()) {
                            throw Error("Invalid path passed");
                        }
                    } else {
                        // If error is not ENOENT then rethrow
                        throw err;
                    }
                } catch (err) {
                    logger.debug(`Client.downloadDirectory: ${err}`);
                    logger.debug(`Client.downloadDirectory: ${err.stack}`);
                    // If parent directory does not exist, or if stat for path
                    // throws an error other than ENOENT then assign path to
                    // falsy value
                    path = null;
                }
            }
        }

        if (!path) {
            path = this.incoming;
            pathIsParent = true;
        }

        // If callback is not function, ignore silently
        if (typeof callback !== "function") {
            logger.debug(
                `Client.downloadDirectory: callback is of type ${typeof callback}. Ignoring callback.`
            );
            // assign callback to empty function
            callback = () => {};
        }

        try {
            if (!path) throw Error("No valid incoming or path passed");
            if (!url) throw Error("No url passed");

            // We'll need to access req later in the Promise chain, so we maintain
            // a external reference
            let req;
            let res = await new Promise((resolve, reject) => {
                // res is IncomingMessage while req is ClientRequest
                req = http(url, res => {
                    let data = "";

                    if (res.statusCode !== 200) {
                        logger.debug(
                            `downloadDirectory: Server responded with ${
                                res.statusCode
                            }: ${res.statusMessage}`
                        );
                        reject(
                            `Server responded with ${res.statusCode}: ${
                                res.statusMessage
                            }`
                        );
                    }

                    if (res.headers["content-type"] !== "application/json")
                        throw Error("URL does not correspond to directory");

                    res.on("data", chunk => {
                        data += chunk;
                    }).on("end", () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (err) {
                            reject("Corrupted response");
                        }
                    });
                }).on("error", err => {
                    // Error on request object, returned by http
                    logger.debug(`Client.downloadDirectory: ${err}`);
                    reject("Error connecting to server.");
                });
            }).catch(err => {
                // If previous promise is rejected then req might not have
                // been aborted
                if (req) req.abort();
                throw err;
            });

            if (!res.children)
                throw Error("URL does not correspond to directory.");

            let dirName = res.name;
            if (pathIsParent) {
                path = Path.join(path, dirName);

                try {
                    let stat = await fstat(path);

                    if (stat.isDirectory())
                        throw Error(`Directory already exists at ${path}`);
                } catch (err) {
                    // If directory does not exist then it's good since we won't
                    // be affecting existing data
                    if (err.code !== "ENOENT") {
                        throw err;
                    }
                }
            }

            // path is now set properly
            await mkdir(path);

            try {
                // Call back for root directory
                callback(0, res.size, path, true);
            } catch (err) {
                // ignore
            }

            // Download directory
            await _downloadDir(url, path, callback);

            return path;
        } catch (err) {
            logger.debug(`Client.downloadDirectory: ${err}`);
            logger.debug(`Client.downloadDirectory: ${err.stack}`);
            throw err;
        }
    }

    // Wrapper around downloadDirectory and downloadFile. Uses meta data to
    // call correct function
    download(url, path, callback) {
        if (!url) {
            return Promise.reject("URL not passed.");
        }

        return this.getMeta(url).then(meta => {
            if (meta.type == "dir") {
                logger.debug(`Client.download: ${url} is directory`);
                return this.downloadDirectory(url, path, callback);
            } else {
                logger.debug(`Client.download: ${url} is file`);
                return this.downloadFile(url, path, callback);
            }
        });
    }

    getMeta(url) {
        if (!url) {
            return Promise.reject("URL not passed.");
        }

        // We'll need to access req later in the Promise chain, so we maintain
        // a external reference
        let req;
        // URL for meta data
        let metaUrl = `${url}/meta`;
        return new Promise((resolve, reject) => {
            // res is IncomingMessage while req is ClientRequest
            req = http(metaUrl, res => {
                let data = "";

                if (res.statusCode !== 200) {
                    logger.debug(
                        `getMeta: Server responded with ${res.statusCode}: ${
                            res.statusMessage
                        }`
                    );
                    reject(
                        `Server responded with ${res.statusCode}: ${
                            res.statusMessage
                        }`
                    );
                }

                if (res.headers["content-type"] !== "application/json")
                    reject(`${metaUrl} does not correspond to meta data`);

                res.on("data", chunk => {
                    data += chunk;
                }).on("end", () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject("Corrupted response");
                    }
                });
            }).on("error", err => {
                // Error on request object, returned by http
                logger.debug(`Client.getMeta: ${err}`);
                reject("Error connecting to server.");
            });
        }).catch(err => {
            // If previous promise is rejected then req might still not have
            // been aborted.
            if (req) req.abort();
            throw err;
        });
    }

    getDirectoryInfo(url) {
        if (!url) {
            return Promise.reject("URL not passed.");
        }

        // We'll need to access req later in the Promise chain, so we maintain
        // a external reference
        let req;

        return new Promise((resolve, reject) => {
            // res is IncomingMessage while req is ClientRequest
            req = http(url, res => {
                let data = "";

                if (res.statusCode !== 200) {
                    logger.debug(
                        `getDirectoryInfo: Server responded with ${
                            res.statusCode
                        }: ${res.statusMessage}`
                    );
                    reject(
                        `Server responded with ${res.statusCode}: ${
                            res.statusMessage
                        }`
                    );
                }

                if (res.headers["content-type"] !== "application/json")
                    reject("URL does not correspond to directory");

                res.on("data", chunk => {
                    data += chunk;
                }).on("end", () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject("Corrupted response");
                    }
                });
            }).on("error", err => {
                // Error on request object, returned by http
                logger.debug(`Client.getDirectoryInfo: ${err}`);
                reject("Error connecting to server.");
            });
        }).then(
            data => {
                // If previous promise isn't rejected then the HTTP request was
                // completed. No need to abort response if any error occurs now.
                if (!data.children)
                    throw Error("URL does not correspond to directory");

                let origin = new URL(url).origin;

                data.children = data.children.map(child => ({
                    ...child,
                    url: `${origin}/${child.id}`
                }));

                return data;
            },
            err => {
                // If control reaches here, our HTTP request was stopped midway
                // We abort our request
                if (req) req.abort();
                throw err;
            }
        );
    }
}