# Changelog

All changes to this project will be annotated here

## 1.1.0 - 2020-01-17

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

## 1.0.4 - 2020-01-14

### Refactor
* Removed debug logs from extension
* Logs the output of tests during execution

## 1.0.3 - 2020-01-14

### Update
* Extension tries to detect if is inside a swift package project

## 1.0.2 - 2020-01-14

### Update
* Readme

### Refactor
* Less spaghetti code
* Removed dependencies from `grep` script (if any of our non Linux friends wants to use this extension)

### Fixed
* Now it should parse the output of `swift build` better to identify tests in case of a full build (fetching and cloning)

## 1.0.1 - 2020-01-14

### Fixed
* Screenshot not showing in the extension Marketplace