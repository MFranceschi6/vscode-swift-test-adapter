import { WorkspaceFolder, Event, EventEmitter, workspace } from 'vscode';
import { RetireEvent, TestAdapter, TestDecoration, TestEvent, TestInfo, TestLoadFinishedEvent, TestLoadStartedEvent, TestRunFinishedEvent, TestRunStartedEvent, TestSuiteEvent, TestSuiteInfo } from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { ChildProcess, spawn } from 'child_process' 
import { TargetInfo } from './TestSuiteParse';
import { v4 } from 'uuid'
import { parse } from 'path';

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

    private isTestLine(line: string): number {
        if(line.startsWith('/')) return 1
        if(line.startsWith('[')) return 0
        if(line == '') return 0
        return -1
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
        let skipNext = 0;
        const stderr: string[] = []
        loadingProcess.stdout.on('data', (data: Buffer) => {
            let lines = data.toString('utf8').split('\n')
            for(let i in lines) {
                setImmediate(() => {
                    const line = lines[i]
                    this.log.debug(line)
                    if (skipNext > 0) {
                        skipNext--;
                        stderr.push(line)
                        return
                    }
                    const action = this.isTestLine(line)
                    if (action == 1) {
                        stderr.push(line)
                        skipNext = 2;
                        return;
                    }
                    if (action == 0) {
                        return;
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
                this.log.debug('here')
                const children = Object.keys(packages).map(targetName => {
                    const target = packages[targetName] as TargetInfo
                    const children = Object.keys(target.childrens).map(className => {
                        const classDef = target.childrens[className]
                        this.log.debug(`grep -r -e \\"class[[:blank:]]\\+${className}[[:blank:]]*:[[:blank:]]*XCTestCase[[:blank:]]*{\\" Tests/${targetName} | cut -f1 -d:`)
                        const grepFileName = spawn('grep', ['-r', '-e', `class[[:blank:]]\\+${className}[[:blank:]]*:[[:blank:]]*XCTestCase[[:blank:]]*{`, `Tests/${targetName}`], {cwd: this.workspace.uri.fsPath})
                        const fileNameProcess = spawn('cut', ['-f1', '-d:'])
                        grepFileName.stdout.pipe(fileNameProcess.stdin)
                        let fileName: string = ''
                        fileNameProcess.stdout.on('data', (data: Buffer) => {
                            this.log.debug(data.toString())
                            fileName = data.toString('utf8').replace('\n', '')
                        })
                        return new Promise<TestSuiteInfo>(resolve => {
                            fileNameProcess.on('exit', (code) => {
                                this.log.debug(code)
                                let classLine: number = 0
                                const grepProcess = spawn('grep', ['-n', '-e', `class[[:blank:]]\\+${className}[[:blank:]]*:[[:blank:]]*XCTestCase[[:blank:]]*{`, fileName], {cwd: this.workspace.uri.fsPath})
                                const classLineProcess = spawn('cut', ['-f1', '-d:'])
                                grepProcess.stdout.pipe(classLineProcess.stdin)
                                classLineProcess.stdout.on('data', (data: Buffer) => {
                                    this.log.debug(data.toString())
                                    classLine = parseInt(data.toString('utf8')) - 1
                                })
                                classLineProcess.on('exit', (code) => {
                                    this.log.debug(code)
                                    classDef.file = `${this.workspace.uri.path}/${fileName}`
                                    classDef.line = classLine
                                    this.log.debug(classDef.line)
                                    const promises = classDef.children.map(child => {
                                        child.file = `${this.workspace.uri.path}/${fileName}`
                                        let testLine: number = 0
                                        const grepProcess = spawn('grep', ['-n', '-e', `func[[:blank:]]\\+${child.label}[[:blank:]]*(`, fileName], {cwd: this.workspace.uri.fsPath})
                                        const testLineProcess = spawn('cut', ['-f1', '-d:'])
                                        grepProcess.stdout.pipe(testLineProcess.stdin)
                                        testLineProcess.stdout.on('data', (data: Buffer) => {
                                            this.log.debug(data.toString())
                                            testLine = parseInt(data.toString('utf8')) - 1
                                        })
                                        return new Promise<null>(res => {
                                            testLineProcess.on('exit', () => {
                                                child.line = testLine
                                                this.log.debug(child.line)
                                                res(null)
                                            })
                                        })
                                    })
                                    Promise.all(promises).then(() => resolve(classDef))
                                })
                            })
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
                })
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
        this.log.debug(suite)
        const event: TestLoadFinishedEvent = {type: 'finished', suite: suite.errored ? undefined : suite, errorMessage: suite.errored ? suite.message : undefined}
        this.log.debug(event)
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
        this.log.debug(tokens)
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
                this.log.debug(decorations)
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
        this.log.debug(event)
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
        this.log.debug(event)
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
                this.log.info(line)
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