# Changelog

All changes to this project will be annotated here

## 1.1.10 2021-06-26

## Add
* Support for macOS different output of the swift test command

## 1.1.9 2021-06-4

## Fix
* Now it doesn't assume the tests to be inside the `Tests/` directory

## 1.1.7 2021-05-12

## Update
* Readme with Known Issues

## 1.1.6 2021-05-12

## Fix
* Loading of tests when loading a project which is building from zero

## 1.1.5 2021-05-12

## Fix
* Compatibility with swift 5.4

## Update
* Readme with example of how to set up the debugger
* Year of dates inside changelog 😅
* Package json dependencies

## 1.1.4 2021-01-19

## Update
* Improved how the logs and error messages of tests are shown

## 1.1.3 - 2021-01-17

## Fix
* Failed to load tests if a test class was not direct subclass of `XCTestCase`

## Update
* Handle erroneous exit code from tests and correctly display the error messages

## 1.1.2 - 2021-01-17

## Fix
* Package.json package method

## 1.1.1 - 2021-01-17

## Update
* Readme
## 1.1.0 - 2021-01-17

## Add
* Possible to enable debug features
* Launch lldb debugger sessions
* Possibility to define arguments to pass to the `swift test` commands
* Screenshot of debug session

## Refactor
* Reorganization of the code repository

## Update
* Readme

## Fix
* Resolved bug in how the output of `swift` command where parsed

## 1.0.4 - 2021-01-14

### Refactor
* Removed debug logs from extension
* Logs the output of tests during execution

## 1.0.3 - 2021-01-14

### Update
* Extension tries to detect if is inside a swift package project

## 1.0.2 - 2021-01-14

### Update
* Readme

### Refactor
* Less spaghetti code
* Removed dependencies from `grep` script (if any of our non Linux friends wants to use this extension)

### Fixed
* Now it should parse the output of `swift build` better to identify tests in case of a full build (fetching and cloning)

## 1.0.1 - 2021-01-14

### Fixed
* Screenshot not showing in the extension Marketplace