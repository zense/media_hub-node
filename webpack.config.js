const Path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

const mainProcConfig = {
    entry: Path.resolve(__dirname, "src", "app", "main.js"),
    output: {
        filename: "main.js",
        path: Path.resolve(__dirname, "dist")
    },
    target: "electron-main",
    module: {
        rules: [
            {
                test: /\.js$/,
                loader: "babel-loader"
            }
        ]
    },
    resolve: {
        modules: [Path.join(__dirname, "src"), "node_modules"]
    }
};

const renderProcConfig = {
    entry: Path.resolve(__dirname, "src", "app", "render", "index.js"),
    output: {
        filename: "render.js",
        path: Path.resolve(__dirname, "dist")
    },
    target: "electron-renderer",
    module: {
        rules: [
            {
                test: /\.js$/,
                loader: "babel-loader"
            },
            {
                test: /\.(png|jpg|gif|svg|eot|ttf|woff|woff2)$/,
                use: {
                    loader: "url-loader",
                    options: {
                        limit: 100000
                    }
                }
            },
            {
                test: /\.css$/,
                loader: "style-loader!css-loader!sass-loader"
            }
        ]
    },
    plugins: [new HtmlWebpackPlugin()],
    resolve: {
        alias: {
            react: "preact-compat",
            "react-dom": "preact-compat"
        },
        modules: [Path.join(__dirname, "src"), "node_modules"]
    }
};

module.exports = [mainProcConfig, renderProcConfig];
