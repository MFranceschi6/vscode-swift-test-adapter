import { Log } from 'vscode-test-adapter-util';
import { TargetInfo } from './TestSuiteParse'
import { dataToLines } from './fsUtils'
import { TestDecoration, TestEvent, TestInfo, TestRunFinishedEvent, TestRunStartedEvent, TestSuiteEvent, TestSuiteInfo } from 'vscode-test-adapter-api';
import { EventEmitter } from 'vscode';
import { parse } from 'path';
import { getPlatform, Platform } from './utils';


const isNotBuildLine = (line: string): boolean => {
    if(line.startsWith('/'))                                                        return false
    else if(line.startsWith('['))                                                   return false
    else if(/^\s*\^/.test(line))                                                    return false
    else if(/^\s/.test(line))                                                       return false
    else if(line == '')                                                             return false
    else if(/^(Fetching|Cloning|Resolving) (https:\/\/|http:\/\/|git@)/.test(line)) return false
    else if("* Build Completed!" == line)                                           return false
    else                                                                            return /[^%]{1,}\.[^%]{1,}\/[^%]{1,}/.test(line)
}

export const getName = (line: string): string => {
    const first = line.indexOf("'")
    const last = line.lastIndexOf("'")
    const name = line.substring(first+1, last)
    if (getPlatform() == Platform.mac) {
        if (name.startsWith('-[') && name.endsWith(']')) {
            const pointIndex = name.indexOf('.')
            const spaceIndex = name.indexOf(' ')
            const className = name.substring(pointIndex+1, spaceIndex)
            const testName = name.substring(spaceIndex + 1, name.length - 1)
            return `${className}.${testName}`
        }
    }
    return name
}

const getEvent = (testRunId: string, type: 'suite' | 'test', name: string, line: string, decorations?: TestDecoration[]): TestSuiteEvent | TestEvent => {
    const secondPortion = line.substring(line.lastIndexOf("'") + 1).trim()
    const tokens = secondPortion.split(' ')
    if(tokens[0] == 'started') {
        switch (type) {
            case 'suite': {
                return {
                    type: 'suite',
                    state: 'running',
                    suite: name,
                    testRunId,
                }
            }
            case 'test': {
                return {
                    type: 'test',
                    state: 'running',
                    test: name,
                    testRunId
                }
            }
        }
    } else if(tokens[0] == 'passed') {
        switch (type) {
            case 'suite': {
                return {
                    type: 'suite',
                    state: 'completed',
                    suite: name,
                    testRunId
                }
            }
            case 'test': {
                return {
                    type: 'test',
                    state: 'passed',
                    tooltip: `Passed in ${tokens.splice(1).join(' ').replace(')', '').replace('(', '')}`,
                    test: name,
                    testRunId,
                    decorations,
                }
            }
        }
    }
    switch (type) {
        case 'suite': {
            return {
                type: 'suite',
                state: 'completed',
                suite: name,
                testRunId
            }
        }
        case 'test': {
            return {
                type: 'test',
                state: 'failed',
                test: name,
                testRunId,
                decorations,
                tooltip: `Failed in ${tokens.splice(1).join(' ').replace(')', '').replace('(', '')}`
            }
        }
    }
}

const handleTestSuiteMessage = (testStatesEmitter: EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>, testRunId: string, line: string, test: string): TestSuiteEvent | undefined => {
    const name = getName(line)
    let event: TestSuiteEvent
    let realName = test.indexOf('.') == -1 ? `${test}.${name.replace('.', '/')}` : test.indexOf('/') == -1 ? test : test.substring(0, test.indexOf('/'))
    if(name == 'All tests')                event = getEvent(testRunId, 'suite', 'root', line) as TestSuiteEvent
    else if(name == 'Selected tests')      event = getEvent(testRunId, 'suite', test.substring(0, test.indexOf('.')), line) as TestSuiteEvent
    else if(name.indexOf('.xctest') == -1) event = getEvent(testRunId, 'suite', realName, line) as TestSuiteEvent
    else return undefined
    if(event.state == 'completed') {
        return event
    }
    testStatesEmitter.fire(event)
    return undefined
}

const handleTestCaseMessage = (testStatesEmitter: EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>, testRunId: string, line: string, test: string, decorations?: TestDecoration[], currentOutpuLines?: string[]): boolean => {
    const name = getName(line)
    let event: TestEvent
    let realName = test.indexOf('.') == -1 ? `${test}.${name.replace('.', '/')}` : test.indexOf('/') == -1 ? `${test.substring(0, test.indexOf('.'))}.${name.replace('.', '/')}` : test
    event = getEvent(testRunId, 'test', realName, line, decorations) as TestEvent
    event.message = currentOutpuLines?.join('\n')
    testStatesEmitter.fire(event)
    if(event.state == 'passed' || event.state == 'failed')
        return true
    return false
}

const tryParseDecoration = (testRunId: string, line: string, outPutLines: string[] | undefined): TestDecoration | undefined => {
    if(line.startsWith('/') && line.indexOf(':') != -1){
        const parsed = parse(line.substring(0, line.indexOf(':')))
        if(parsed.ext != '.swift') return undefined
        const lineWithoutPath = line.substring(line.indexOf(':') + 1)
        const lineNum = parseInt(lineWithoutPath.substring(0, lineWithoutPath.indexOf(':'))) - 1
        const tokens = lineWithoutPath.split(':')
        const message = `${tokens[1]}: ${tokens[3]}`
        const hover = tokens.splice(4).join(':')
        if(isNaN(lineNum)) return undefined
        return {
            line: lineNum,
            message,
            hover,
            file: line.substring(0, line.indexOf(':'))
        }
    }
    return undefined
}

export const parseSwiftRunOutput = (data: {
    nextLineIsTestSuiteStats: boolean,
    event: TestSuiteEvent | undefined,
    currentOutPutLines: string [] | undefined,
    lastLine: string,
    currentDecorators: TestDecoration[] | undefined
}, handlingData: {count: number}, testStatesEmitter: EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>, testRunId: string, test: string, log: Log,): (data: Buffer) => void => {
    return dataToLines((lines) => {
    for(let i in lines) {
        handlingData.count++
        const line = lines[i]
        data.lastLine = line
        if(data.nextLineIsTestSuiteStats) {
            data.nextLineIsTestSuiteStats = false;
            data.event!.tooltip = line.trim()
            testStatesEmitter.fire(data.event!)
        }
        else if(line.startsWith('Test Suite')) {
            data.event = handleTestSuiteMessage(testStatesEmitter, testRunId, line, test)
            if(data.event) {
                data.nextLineIsTestSuiteStats = true
            }
        }
        else if(line.startsWith('Test Case')) {
            if (handleTestCaseMessage(testStatesEmitter, testRunId, line, test, data.currentDecorators, data.currentOutPutLines)) {
                data.currentDecorators = undefined
                data.currentOutPutLines = undefined
            }
        }
        else {
            if(!/\t Executed [\d]+ test, with [\d]+ failures \([\d]+ unexpected\) in /.test(line)) log.info(line)
            const decoration = tryParseDecoration(testRunId, line, data.currentOutPutLines)
            if(decoration) {
                if(data.currentDecorators) data.currentDecorators.push(decoration)
                else {
                    data.currentDecorators = []
                    data.currentDecorators.push(decoration)
                }
            } else {
                if(isNotBuildLine(line)) {
                    if(data.currentOutPutLines) data.currentOutPutLines.push(line)
                    else {
                        data.currentOutPutLines = []
                        data.currentOutPutLines.push(line)
                    }
                }
            }
        }
        handlingData.count--
    }
})
}

export const parseSwiftLoadTestOutput = (debuggable: boolean, handlingData: {count: number}, stderr: string[], log: Log, packages: { [key: string]: TargetInfo | undefined }): (data: Buffer) => void => dataToLines((lines) => {
    for(let i in lines) {
        handlingData.count++
        setImmediate(() => {
            handlingData.count--
            const line = lines[i]
            log.info(line)
            const action = isNotBuildLine(line)
            if(!action) {
                stderr.push(line)
                return
            }
            let tokens = line.split('.')
            const targetName = tokens[0]
            const pack = packages[targetName]
            let target: TargetInfo
            if(pack) {
                target = pack
            } else {
                target = {
                    type: 'suite',
                    id: targetName,
                    label: targetName,
                    description: `Target ${targetName}`,
                    tooltip: `Target ${targetName}`,
                    debuggable: false,
                    childrens: {}
                }
                packages[targetName] = target
            }
            tokens = tokens[1].split('/')
            const className = tokens[0]
            const classSuite = target.childrens[className]
            let cl: TestSuiteInfo
            if(classSuite) {
                cl = classSuite
            } else {
                cl = {
                    type: 'suite',
                    id: `${targetName}.${className}`,
                    label: className,
                    description: `Class ${className}`,
                    tooltip: `Class ${className}`,
                    debuggable: false,
                    children: []
                }
                target.childrens[className] = cl
            }
            const testName = tokens[1]
            const testCase: TestInfo = {
                type: 'test',
                id: `${targetName}.${className}/${testName}`,
                label: testName,
                description: `Test Case ${testName}`,
                tooltip: `Test Case ${testName}`,
                debuggable
            }
            cl.children.push(testCase)
        })
    }
})


const parseFirstLine = (line: string): {info: string, file: string, line: number } => {
    const tokens = line.split(':')
    const info = tokens[tokens.length - 1].trim()
    const file = info.split(' ')[1]
    const lineNum = parseInt(info.split(' ')[3]) - 1
    return {info: tokens.splice(0, tokens.length - 1).join(':'), file, line: lineNum}
}

export const parseSwiftRunError = (data: {lines: string[], firstLine: string | undefined, file: string | undefined, line: number | undefined }): (data: Buffer) => void => dataToLines((lines) => {
    if(data.lines.length == 0) {
        const {info, file, line} = parseFirstLine(lines[0])
        data.firstLine = info
        data.file = file
        data.line = line
    }
    data.lines = data.lines.concat(lines)
})