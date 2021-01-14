import * as vscode from 'vscode';
import { TestHub, testExplorerExtensionId } from 'vscode-test-adapter-api';
import { Log, TestAdapterRegistrar } from 'vscode-test-adapter-util';
import { SwiftAdapter } from './swiftAdapter';

export async function activate(context: vscode.ExtensionContext) {

	const workspaceFolder = (vscode.workspace.workspaceFolders || [])[0];

	const directory = await vscode.workspace.fs.readDirectory(workspaceFolder.uri)
	
	if(!directory.find((([name, type]) => {
		if(name === "Package.swift") return true
		return false
	}))) {
		return
	}
	// create a simple logger that can be configured with the configuration variables
	const log = new Log('swiftTest.swift', workspaceFolder, 'Swift Explorer Log');
	context.subscriptions.push(log);

	// get the Test Explorer extension
	const testExplorerExtension = vscode.extensions.getExtension<TestHub>(testExplorerExtensionId);
	if (log.enabled) log.info(`Test Explorer ${testExplorerExtension ? '' : 'not '}found`);

	if (testExplorerExtension) {

		const testHub = testExplorerExtension.exports;

		context.subscriptions.push(new TestAdapterRegistrar(
			testHub,
			workspaceFolder => new SwiftAdapter(workspaceFolder, log),
			log
		));
	}
}
