/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from "node:path";
import type { ExtensionContext } from "vscode";
// import { workspace } from "vscode";
import type {
	LanguageClientOptions,
	ServerOptions,
} from "vscode-languageclient/node";

import { TransportKind, LanguageClient } from "vscode-languageclient/node";

let client: LanguageClient;

export function activate(context: ExtensionContext) {
	// TODO:Should return if workspace isn't Angular project
	// Maybe we should check if the workspace has angular.json
	// const workspaceFolders = workspace.workspaceFolders;

	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join("server", "out", "server.js"),
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
		},
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: "file", language: "typescript" },
			{ scheme: "file", language: "html" },
		],
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		"ngxMarkuplintVSCode",
		"ngx-markuplint-vscode",
		serverOptions,
		clientOptions,
	);

	// Start the client. This will also launch the server
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
