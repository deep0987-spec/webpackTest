const webpack = require('webpack')
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CleanWebpackPlugin = require('clean-webpack-plugin')
const ExtractTextPlugin = require('extract-text-webpack-plugin')

module.exports = {
  entry: {
    index: './index.js',
    main: './main.js',
    // vender: ['react', 'react-dom']
  },
  output: {
    // filename: '[name].[hash:6].js',
    filename: '[name].[chunkhash:6].js',
    // chunkFilename: '[name].[chunkhash:2].js',
    path: path.resolve(__dirname, 'public'),
  },
  watch: true,
  module: {
    rules:[
      {
        test: '/\.css/',
        use: ExtractTextPlugin.extract({
          fallback: "style-loader",
          use: "css-loader"
        })
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './index.html',
      filename: 'index.html'
    }),
    // 分离CSS
    new ExtractTextPlugin('index.css'),
    // 清除旧文件
    new CleanWebpackPlugin([path.resolve(__dirname, 'public/*')],{

    }),
    // chunk文件
    // new webpack.optimize.CommonsChunkPlugin({
    //   name: 'common',
    //   filename: '[name].[hash:3].js',
    //   minChunks: Infinity,
    // })
  ]
}
