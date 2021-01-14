# Swift Test Adapter for Visual Studio Code

This extension for [Text Explorer UI](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer) add ide test capabilities with swift SPM in VSCode

## Features

 * Reload test lists on save if a test file changes (_Configurable_)
 * Run single test or all tests in a class or all test in a target instead of `swift test` everything everytime
 * Detects test file location and line
 * Highlights test failed lines with output
 * Prints test run output

![Screenshot1](img/screenshot.png)

## Missing Features

 * Debugger... which is actually missing from Linux
 * AutoRun
 * Parallel tests (but not likelly at this moment)
 * Code Coverage

## Support

This extension is really new so I suppose bugs will be frequent, feel free to open any [issue](https://github.com/MFranceschi6/vscode-swift-test-adapter/issues) if you find something or you want to propose a new feature