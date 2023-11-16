# Changelog Node-RED Contrib Payload Logger
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased] - 2023-XX-XX
### Configuration
### Added
### Changed
### Fixed
### Dependencies
#### Updated

## 1.1.0 - 2023-11-12
### Added
- Append function to add multiple logs to one file. Special handling for csv and json.
- .nvmrc-file for nodejs version
- minimum nodejs version to package.json
- minimum node-red version to package.json
### Changed
- Updated node example
### Fixed
- JSONata for identifier

## 1.0.1 - 2023-03-21
### Changed
- updated key in package.json for node-red plattform

## 1.0.0 - 2023-03-21
### Configuration
- Added the possibility to configure the log path, the archive path, the archive time and the delete time for multiple log paths
### Added
- Added log node to log the payload using a specific configuration
- Added a cleanup process to archive or delete old log files
