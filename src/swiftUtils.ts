import { Log } from 'vscode-test-adapter-util';
import { TargetInfo } from './TestSuiteParse'
import { dataToLines } from './fsUtils'
import { TestDecoration, TestEvent, TestInfo, TestRunFinishedEvent, TestRunStartedEvent, TestSuiteEvent, TestSuiteInfo } from 'vscode-test-adapter-api';
import { EventEmitter } from 'vscode';
import { parse } from 'path';


const isTestLine = (line: string): boolean => {
    if(line.startsWith('/')) return false
    else if(line.startsWith('[')) return false
    else if(/^\s*\^/.test(line)) return false
    else if(/^\s/.test(line)) return false
    else if(line == '') return false
    else if(/^(Fetching|Cloning|Resolving) (https:\/\/|http:\/\/|git@)/.test(line)) return false
    return true
}

const getName = (line: string): string => {
    const first = line.indexOf("'")
    const last = line.lastIndexOf("'")
    return line.substring(first+1, last)
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

const handleTestCaseMessage = (testStatesEmitter: EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>, testRunId: string, line: string, test: string, decorations?: TestDecoration[]): boolean => {
    const name = getName(line)
    let event: TestEvent
    let realName = test.indexOf('.') == -1 ? `${test}.${name.replace('.', '/')}` : test.indexOf('/') == -1 ? `${test.substring(0, test.indexOf('.'))}.${name.replace('.', '/')}` : test
    event = getEvent(testRunId, 'test', realName, line, decorations) as TestEvent
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
        if(isNaN(lineNum)) return undefined
        return {
            line: lineNum,
            message: lineWithoutPath.substring(lineWithoutPath.indexOf(':') + 1),
            hover: outPutLines ? outPutLines.join('\n') : undefined,
            file: line.substring(0, line.indexOf(':'))
        }
    }
    return undefined
}

export const parseSwiftRunOutput = (testStatesEmitter: EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>, testRunId: string, test: string, log: Log,): (data: Buffer) => void => {
    let nextLineIsTestSuiteStats = false;
    let event: TestSuiteEvent | undefined;
    let currentOutPutLines: string [] | undefined
    let currentDecorators: TestDecoration[] | undefined
    return dataToLines((lines) => {
    for(let i in lines) {
        const line = lines[i]
        if(nextLineIsTestSuiteStats) {
            nextLineIsTestSuiteStats = false;
            event!.tooltip = line.trim()
            testStatesEmitter.fire(event!)
        }
        if(line.startsWith('Test Suite')) {
            event = handleTestSuiteMessage(testStatesEmitter, testRunId, line, test)
            if(event) {
                nextLineIsTestSuiteStats = true
            }
        }
        else if(line.startsWith('Test Case')) {
            currentOutPutLines = undefined
            if (handleTestCaseMessage(testStatesEmitter, testRunId, line, test, currentDecorators)) {
                currentDecorators = undefined
            }
        }
        else {
            if(!/\t Executed [\d]+ test, with [\d]+ failures \([\d]+ unexpected\) in /.test(line)) log.info(line)
            const decoration = tryParseDecoration(testRunId, line, currentOutPutLines)
            if(decoration) {
                if(currentDecorators) currentDecorators.push(decoration)
                else {
                    currentDecorators = []
                    currentDecorators.push(decoration)
                }
            } else {
                if(currentOutPutLines) currentOutPutLines.push(line)
                else {
                    currentOutPutLines = []
                    currentOutPutLines.push(line)
                }
            }
        }
    }
})
}

export const parseSwiftLoadTestOutput = (stderr: string[], log: Log, packages: { [key: string]: TargetInfo | undefined }): (data: Buffer) => void => dataToLines((lines) => {
    for(let i in lines) {
        setImmediate(() => {
            const line = lines[i]
            log.info(line)
            const action = isTestLine(line)
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
                debuggable: true
            }
            cl.children.push(testCase)
        })
    }
    })
