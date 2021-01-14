import { WorkspaceFolder, Event, EventEmitter, workspace } from 'vscode';
import { RetireEvent, TestAdapter, TestDecoration, TestEvent, TestInfo, TestLoadFinishedEvent, TestLoadStartedEvent, TestRunFinishedEvent, TestRunStartedEvent, TestSuiteEvent, TestSuiteInfo } from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { ChildProcess, spawn } from 'child_process' 
import { TargetInfo } from './TestSuiteParse';
import { v4 } from 'uuid'
import { parse } from 'path';
import { grep } from './fsUtils'

const basePath = 'swiftTest.swift'

export class SwiftAdapter implements TestAdapter {

    private disposables: { dispose(): void }[] = [];
    private targets: string[] = [];

    private loading = false;

    private readonly testsEmitter = new EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter = new EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
    private readonly autorunEmitter = new EventEmitter<void>();
    private readonly retireEmitter = new EventEmitter<RetireEvent>();


	get tests(): Event<TestLoadStartedEvent | TestLoadFinishedEvent> { return this.testsEmitter.event; }
	get testStates(): Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> { return this.testStatesEmitter.event; }
    get autorun(): Event<void> | undefined { return this.autorunEmitter.event; }
    get retire(): Event<RetireEvent> {
        return this.retireEmitter.event;
    }

    private registerForEvents() {
        workspace.onDidSaveTextDocument(textDocument => {
            if(textDocument.uri.path.indexOf(`${this.workspace.uri.path}/Tests`) != -1) {
                if(workspace.getConfiguration(`${basePath}.reloadOnTextSave`)) {
                    this.load()
                }
            } else if(textDocument.uri.path.indexOf(`${this.workspace.uri.path}/Sources`) != -1) {
                this.retireEmitter.fire({})
            }
        })
    }

    constructor(
        public readonly workspace: WorkspaceFolder,
        private readonly log: Log
        ) {
            this.log.info('Initializing swift adapter');

            this.disposables.push(this.testsEmitter);
            this.disposables.push(this.testStatesEmitter);
            this.disposables.push(this.autorunEmitter);

            this.registerForEvents()
    }

    private isTestLine(line: string): boolean {
        if(line.startsWith('/')) return false
        else if(line.startsWith('[')) return false
        else if(/^\s*\^/.test(line)) return false
        else if(/^\s/.test(line)) return false
        else if(line == '') return false
        else if(/^(Fetching|Cloning|Resolving) (https:\/\/|http:\/\/|git@)/.test(line)) return false
        return true
    }

    private async loadSuite(): Promise<TestSuiteInfo> {
        const loadingProcess = spawn('swift', [
                'test',
                '--enable-test-discovery',
                '-l'
            ], {cwd: this.workspace.uri.fsPath})
        const suite: TestSuiteInfo = {
            type: 'suite',
            id: 'root',
            label: 'Swift',
            description: "Swift",
            tooltip: "All Tests",
            debuggable: false,
            children: []
        }

        const packages: { [key: string]: TargetInfo | undefined } = {};
        const stderr: string[] = []
        loadingProcess.stdout.on('data', (data: Buffer) => {
            let lines = data.toString('utf8').split('\n')
            for(let i in lines) {
                setImmediate(() => {
                    const line = lines[i]
                    this.log.info(line)
                    const action = this.isTestLine(line)
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
                        debuggable: false
                    }
                    cl.children.push(testCase)
                })
            }
        })

        return new Promise((resolve) => {
            loadingProcess.on('exit', (code) => {
                if(code != 0) {
                    suite.errored = true
                    suite.message = stderr.join('\n')
                    setTimeout(() => resolve(suite), 1000)
                    
                }
                const children = Object.keys(packages).map(targetName => {
                    const target = packages[targetName] as TargetInfo
                    const children = Object.keys(target.childrens).map(className => {
                        const classDef = target.childrens[className]
                        const regex = `class[\\s]+${className}[\\s]*:[\\s]*XCTestCase[\\s]*{`
                        return grep(RegExp(regex), `${this.workspace.uri.fsPath}/Tests/${targetName}`, true, true)
                        .then(results => {
                            const lines = results[0].split(':')
                            const fileName = lines[0]
                            const lineNum = parseInt(lines[1]) - 1
                            classDef.file = fileName
                            classDef.line = lineNum
                            return Promise.all(classDef.children.map(child => {
                                child.file = fileName
                                const regex = `func[\\s]+${child.label}[\\s]*\\(`
                                return grep(RegExp(regex), fileName, false, true)
                                .then(lines => lines[0].split(':')[0])
                                .then(lineNumber => parseInt(lineNumber) - 1)
                                .then(lineNum => { child.line = lineNum })
                            })).then(() => { return classDef })
                        })
                    })
                    return Promise.all(children).then(children => {
                        return <TestSuiteInfo> {
                            type: 'suite',
                            id: target.id,
                            label: target.label,
                            description: target.description,
                            tooltip: target.tooltip,
                            debuggable: false,
                            children
                        }
                    })
                })

                Promise.all(children).then(children => {
                    suite.children = children
                    resolve(suite)
                }).catch(reject => resolve(suite))
            })
        })
    }


    async load(): Promise<void> {
        this.log.info('Loading swift tests');
        if(this.loading) return;
        this.loading = true;
        this.testsEmitter.fire({type: 'started'})
        const suite = await this.loadSuite();
        this.targets = suite.children.map(child => child.id)
        const event: TestLoadFinishedEvent = {type: 'finished', suite: suite.errored ? undefined : suite, errorMessage: suite.errored ? suite.message : undefined}
        this.testsEmitter.fire(event)
        this.retireEmitter.fire({})
        this.loading = false
    }

    private getName(line: string): string {
        const first = line.indexOf("'")
        const last = line.lastIndexOf("'")
        return line.substring(first+1, last)
    }

    private getEvent(testRunId: string, type: 'suite' | 'test', name: string, line: string, decorations?: TestDecoration[]): TestSuiteEvent | TestEvent {
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

    private handleTestSuiteMessage(testRunId: string, line: string, test: string): TestSuiteEvent | undefined {
        const name = this.getName(line)
        let event: TestSuiteEvent
        let realName = test.indexOf('.') == -1 ? `${test}.${name.replace('.', '/')}` : test.indexOf('/') == -1 ? test : test.substring(0, test.indexOf('/'))
        if(name == 'All tests')                event = this.getEvent(testRunId, 'suite', 'root', line) as TestSuiteEvent
        else if(name == 'Selected tests')      event = this.getEvent(testRunId, 'suite', test.substring(0, test.indexOf('.')), line) as TestSuiteEvent
        else if(name.indexOf('.xctest') == -1) event = this.getEvent(testRunId, 'suite', realName, line) as TestSuiteEvent
        else return undefined
        if(event.state == 'completed') {
            return event
        }
        this.testStatesEmitter.fire(event)
        return undefined
    }

    private handleTestCaseMessage(testRunId: string, line: string, test: string, decorations?: TestDecoration[]): boolean {
        const name = this.getName(line)
        let event: TestEvent
        let realName = test.indexOf('.') == -1 ? `${test}.${name.replace('.', '/')}` : test.indexOf('/') == -1 ? `${test.substring(0, test.indexOf('.'))}.${name.replace('.', '/')}` : test
        event = this.getEvent(testRunId, 'test', realName, line, decorations) as TestEvent
        this.testStatesEmitter.fire(event)
        if(event.state == 'passed' || event.state == 'failed')
            return true
        return false
    }

    private tryParseDecoration(testRunId: string, line: string, outPutLines: string[] | undefined): TestDecoration | undefined {
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

    private handleProcess(testRunId: string, test: string): (data: Buffer) => void {
        let nextLineIsTestSuiteStats = false;
        let event: TestSuiteEvent | undefined;
        let currentOutPutLines: string [] | undefined
        let currentDecorators: TestDecoration[] | undefined
        return (data) => {
            const lines = data.toString().split('\n')
            for(let i in lines) {
                const line = lines[i]
                if(nextLineIsTestSuiteStats) {
                    nextLineIsTestSuiteStats = false;
                    event!.tooltip = line.trim()
                    this.testStatesEmitter.fire(event!)
                }
                if(line.startsWith('Test Suite')) {
                    event = this.handleTestSuiteMessage(testRunId, line, test)
                    if(event) {
                        nextLineIsTestSuiteStats = true
                    }
                }
                else if(line.startsWith('Test Case')) {
                    currentOutPutLines = undefined
                    if (this.handleTestCaseMessage(testRunId, line, test, currentDecorators)) {
                        currentDecorators = undefined
                    }
                }
                else {
                    if(!/\t Executed [\d]+ test, with [\d]+ failures \([\d]+ unexpected\) in /.test(line)) this.log.info(line)
                    const decoration = this.tryParseDecoration(testRunId, line, currentOutPutLines)
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
        }
    }

    private runningProcesses: { [key: string]: ChildProcess } = {}
    private cancelled = false;

    private runImpl(test: string, testRunId: string): Promise<void> {
        let process: ChildProcess;
        process = spawn('swift',
            ['test', '--enable-test-discovery', '--filter', test], {cwd: this.workspace.uri.fsPath, shell: true})
        this.runningProcesses[test] = process;
        process.stdout!.on('data', this.handleProcess(testRunId, test))

        return new Promise((resolve) => {
            process.on('exit', () => {
                delete this.runningProcesses[testRunId]
                resolve()
            })
        })
    }


    private notAsyncronousFor<T, R>(array: T[], handler: (param: T) => Promise<R>): Promise<R[]> {
        const runner = async (index: number, results: R[]): Promise<R[]> => {
            if(index >= array.length) return results
            let result = await handler(array[index])
            results.push(result)
            return await runner(index + 1, results)
        }

        return runner(0, [])
    }

    async run(tests: string[]): Promise<void> {
        this.log.info("Starting test suite: "+tests[0])
        const testRunId = v4()
        this.testStatesEmitter.fire(<TestRunStartedEvent> { type: 'started', tests: tests, testRunId })

        if(tests[0] != 'root') {
            await this.runImpl(tests[0], testRunId)
        } else {
            await this.notAsyncronousFor(this.targets, (target) => {
                if(this.cancelled)
                    return Promise.resolve()
                return this.runImpl(target, testRunId)
            })
        }
        this.testStatesEmitter.fire(<TestRunFinishedEvent> { type: 'finished', testRunId })
        this.cancelled = false
    }
    debug?(tests: string[]): Promise<void> {
        throw new Error('Method not implemented.');
    }
    cancel(): void {
        this.cancelled = true
        Object.keys(this.runningProcesses).forEach(key => {
            this.runningProcesses[key].kill('SIGINT')
        })
    }

    dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}

}