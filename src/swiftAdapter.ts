import { ChildProcess, exec, spawn } from 'child_process';
import { promises } from 'fs';
import { v4 } from 'uuid';
import { debug, Event, EventEmitter, workspace, WorkspaceFolder } from 'vscode';
import { RetireEvent, TestAdapter, TestDecoration, TestEvent, TestLoadFinishedEvent, TestLoadStartedEvent, TestRunFinishedEvent, TestRunStartedEvent, TestSuiteEvent, TestSuiteInfo } from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { grep } from './fsUtils';
import { parseSwiftLoadTestOutput, parseSwiftRunError, parseSwiftRunOutput } from './swiftUtils';
import { TargetInfo } from './TestSuiteParse';
import { getPlatform, Platform } from './utils';
import { SwiftPackageManifestParser, SwiftPackageManifest, SwiftTarget } from './swiftPackage';

const basePath = 'swiftTest.swift'
const open = promises.open
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

    private accountedParams(param: string): boolean {
        return param != '-l' &&
               param != '--list-tests' &&
               param != '--enable-test-discovery'
    }

    private loadArgs(): string[] {
        let args: string[] = []
        if(workspace.getConfiguration(`${basePath}.enableDebug`)) {
            args = args.concat(["-Xswiftc", "-Xfrontend", "-Xswiftc", "-serialize-debugging-options"])
        }
        let testParams = workspace.getConfiguration(`${basePath}`).get<string[]>('testParams') || []
        testParams = testParams.filter(this.accountedParams)
        return args.concat(testParams)
    }

    private async awaitForOutputHandling(handlingData: {count: number}): Promise<void> {

        const awaitImpl = (executor: (value: void | Promise<void>) => void) => {
            if(handlingData.count != 0) {
                setTimeout(() => awaitImpl(executor), 1000)
                return
            }
            executor()
        }
        return new Promise(resolve => {
            awaitImpl(resolve)
        })
    }

    private async loadPackageManifest(): Promise<null | SwiftPackageManifest> {
        const path = this.workspace.uri.fsPath
        
        return new Promise<string>((resolve, reject) => {
            exec("swift package dump-package", {cwd: path}, function (err, stdout, stderr) {
                if (err != null) {
                    throw err;
                }
                if (stderr != '') {
                    reject()
                }
                
                resolve(stdout.trim())
            })
        }).then((response) => {
            return new Promise<SwiftPackageManifest>((resolve) => {
                resolve(SwiftPackageManifestParser.toSwiftPackageManifest(response))
            }).catch(() => { return null }); // If parsing of manifest fails, fail silently and fall back to heuristics for test paths; parsing might have failed because of unknown future Swift versions.
        })
    }

    private async loadSuite(): Promise<TestSuiteInfo> {
        const suite: TestSuiteInfo = {
            type: 'suite',
            id: 'root',
            label: 'Swift',
            description: `${this.workspace.name}`,
            tooltip: "All Tests",
            debuggable: false,
            children: []
        }

        let swiftPackage: SwiftPackageManifest | null
        try {
            swiftPackage = await this.loadPackageManifest()
        } catch {
            return Promise.resolve(suite)
        }

        let args = [
            'test',
            '--enable-test-discovery',
            '-l'
        ]
        args = args.concat(this.loadArgs())
        const loadingProcess = spawn('swift', args, {cwd: this.workspace.uri.fsPath})

        const packages: { [key: string]: TargetInfo | undefined } = {};
        const stderr: string[] = []
        let handlingData = {count: 0 }
        loadingProcess.stdout.on('data', parseSwiftLoadTestOutput(workspace.getConfiguration(`${basePath}`).get<boolean>('enableDebug') || false, handlingData, stderr, this.log, packages))
        return new Promise((resolve) => {
            loadingProcess.on('exit', (code) => {
                if(code != 0) {
                    suite.errored = true
                    suite.message = stderr.join('\n')
                    setTimeout(() => resolve(suite), 1000)
                    return;
                }
                this.awaitForOutputHandling(handlingData).then(() => {
                    var packageTargetDict: { [key: string]: SwiftTarget } = {}
                    if (swiftPackage?.targets != null) {
                        for (const target of swiftPackage.targets) {
                            packageTargetDict[target.name] = target
                        }
                    }
                    
                    const children = Object.keys(packages).map(targetName => {
                        const targetInPackage = packageTargetDict[targetName]
                        const targetPath = targetInPackage?.path
                        const target = packages[targetName] as TargetInfo
                        
                        const children = Object.keys(target.childrens).map(className => {
                            var searchDirectories: string[] = [
                                `${this.workspace.uri.fsPath}/Tests/${targetName}`,
                                `${this.workspace.uri.fsPath}/Sources/${targetName}`,
                            ]
                            if (targetPath != null) {
                                const declaredPath = `${this.workspace.uri.fsPath}/${targetPath}`

                                if (searchDirectories.indexOf(declaredPath) == -1) {
                                    searchDirectories.unshift(`${this.workspace.uri.fsPath}/${targetPath}`)
                                }
                            }

                            const classDef = target.childrens[className]
                            const regex = `class[\\s]+${className}[\\s]*:.*{`

                            const grepCalls = searchDirectories.map((path) => {
                                return () => grep(RegExp(regex), path, true, true)
                            })
                            
                            return grepCalls
                            .reduce((p, fn) => p.catch(fn), new Promise<string[]>((_, reject) => { reject() }))
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
                                    .catch(error => this.log.error(error))
                                })).then(() => { return classDef })
                            })
                            .catch(reason => {
                                this.log.debug(reason)
                                return null
                            })
                        })
                        
                        return Promise.all(children).then(childrens => {
                                const children = childrens.filter(child => child != null)
                                if (children.length != 0) {
                                    return <TestSuiteInfo> {
                                        type: 'suite',
                                        id: target.id,
                                        label: target.label,
                                        description: target.description,
                                        tooltip: target.tooltip,
                                        debuggable: false,
                                        children
                                    }
                                }
                                return null
                        })
                    })

                    Promise.all(children).then(children => {
                        const child = children.filter(child => child != null) as TestSuiteInfo[]
                        suite.children = child
                        resolve(suite)
                    }).catch(reject => resolve(suite))
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
        const event: TestLoadFinishedEvent = {type: 'finished', suite: suite.errored ? undefined : suite, errorMessage: suite.errored ? suite.message : undefined}
        this.testsEmitter.fire(event)
        this.retireEmitter.fire({})
        this.loading = false
    }

    private runningProcesses: { [key: string]: ChildProcess } = {}
    private cancelled = false;

    private runImpl(test: string, testRunId: string): Promise<void> {
        let process: ChildProcess;
        let args = ['test', '--enable-test-discovery', '--filter', test]
        args = args.concat(this.loadArgs())
        this.log.debug(args)
        process = spawn('swift',
            args, {cwd: this.workspace.uri.fsPath, shell: true})
        this.runningProcesses[test] = process;
        const handlingData = {count: 0}
        const data: {
            nextLineIsTestSuiteStats: boolean,
            event: TestSuiteEvent | undefined,
            currentOutPutLines: string [] | undefined,
            currentDecorators: TestDecoration[] | undefined,
            lastLine: string
        } = {
            nextLineIsTestSuiteStats: false,
            event:  undefined,
            currentOutPutLines: undefined,
            currentDecorators: undefined,
            lastLine: ""
        }
        const outputError: {lines: string[], firstLine: string | undefined, file: string | undefined, line: number | undefined} = {
            lines: [],
            firstLine: undefined,
            file: undefined,
            line: undefined
        }
        
        if (getPlatform() == Platform.linux) {
            process.stdout!.on('data', parseSwiftRunOutput(data, handlingData, this.testStatesEmitter, testRunId, test, this.log))
            process.stderr!.on('data', parseSwiftRunError(outputError))
        } else {
            process.stderr!.on('data', parseSwiftRunOutput(data, handlingData, this.testStatesEmitter, testRunId, test, this.log))
        }
        return new Promise((resolve) => {
            process.on('exit', async (code) => {
                await this.awaitForOutputHandling(handlingData)
                delete this.runningProcesses[testRunId]
                if(code == 1) {
                    if(data.lastLine == 'Exited with signal code 4') {
                        if(test.indexOf('/') != -1)
                            this.testStatesEmitter.fire(<TestEvent>{
                                type: 'test',
                                test,
                                testRunId,
                                state: 'errored',
                                message: outputError.lines.join('\n'),
                                decorations: [
                                    {
                                        line: outputError.line,
                                        file: outputError.file,
                                        message: outputError.firstLine,
                                        hover: outputError.lines.join('\n')
                                    }
                                ]
                            })
                        else {
                            this.testStatesEmitter.fire(<TestSuiteEvent> {
                                type: 'suite',
                                suite: test,
                                testRunId,
                                state: 'errored',
                                message: outputError.lines.join('\n')
                            })
                        }
                    }
                }
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

    finished: boolean = false

    debug?(tests: string[]): Promise<void> {
        return new Promise((resolve, reject) => exec("swift package describe --type json", {cwd: this.workspace.uri.fsPath}, async (err, stdout) => {
            if(err) {
                this.log.error("Error obtaining package information, is your Package.swift valid")
                reject("Error obtaining package information, is your Package.swift valid")
            }
            const testRunId = v4()
            const packageName = JSON.parse(stdout)['name']
            try {
                await promises.unlink(`${this.workspace.uri.fsPath}/.build/debug/${packageName}testRun`)
            } catch { }
            debug.startDebugging(this.workspace, {
                name: 'Debug Test',
                request: 'launch',
                type: 'lldb',
                terminal: 'integrated',
                stdio: [null, `${this.workspace.uri.fsPath}/.build/debug/${packageName}testRun`, getPlatform() == Platform.linux ? null : `${this.workspace.uri.fsPath}/.build/debug/${packageName}testRun`],
                program: `${this.workspace.uri.fsPath}/.build/debug/${packageName}PackageTests.xctest`,
                args: [tests[0]],
            }).then(async () => {
                this.testStatesEmitter.fire(<TestRunStartedEvent> { type: 'started', tests: tests, testRunId })
                this.finished = false
                debug.onDidTerminateDebugSession(async (e) => {
                    this.finished = true
                    await this.parseOutput(testRunId, tests[0], packageName)
                })
            }, exception => {
                this.log.error(exception)
                reject(exception)
            })
        }))
    }

    private async parseOutput(testRunId: string, test: string, packageName: string) {
        const file = await open(`${this.workspace.uri.fsPath}/.build/debug/${packageName}testRun`, 'r')
        const data: {
            nextLineIsTestSuiteStats: boolean,
            event: TestSuiteEvent | undefined,
            currentOutPutLines: string [] | undefined,
            currentDecorators: TestDecoration[] | undefined,
            lastLine: string
        } = {
            nextLineIsTestSuiteStats: false,
            event:  undefined,
            currentOutPutLines: undefined,
            currentDecorators: undefined,
            lastLine: ""
        }
        const handler = parseSwiftRunOutput(data, {count: 0}, this.testStatesEmitter, testRunId, test, this.log)
        await this.parseFileOutput(file, handler)
        this.testStatesEmitter.fire(<TestRunFinishedEvent> { type: 'finished', testRunId })
        await file.close()
        await promises.unlink(`${this.workspace.uri.fsPath}/.build/debug/${packageName}testRun`)
    }

    private async parseFileOutput(file: promises.FileHandle, handler: (data: Buffer) => void) {
        const { bytesRead, buffer } = await file.read(Buffer.alloc(100), 0, 100)
        if(bytesRead != 0) {
            handler(buffer.slice(0, bytesRead))
            await this.parseFileOutput(file, handler)
        }
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