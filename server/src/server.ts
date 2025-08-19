/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import type {
	Diagnostic,
	DocumentDiagnosticReport,
	DiagnosticSeverity,
} from "vscode-languageserver/node";

import {
	TextDocuments,
	TextDocumentSyncKind,
	createConnection,
	DocumentDiagnosticReportKind,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

import { format } from "prettier";
import type { BridgeMLResultInfo } from "ngx-html-bridge-markuplint";

const connection = createConnection();

const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => {
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			diagnosticProvider: {
				interFileDependencies: false,
				workspaceDiagnostics: false,
			},
		},
	};
});

connection.onDidChangeConfiguration(() => {
	connection.languages.diagnostics.refresh();
});

connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);

	if (document !== undefined) {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: await validateTextDocument(document),
		} satisfies DocumentDiagnosticReport;
	}

	// We don't know the document. We can either try to read it from disk
	// or we don't report problems for it.
	return {
		kind: DocumentDiagnosticReportKind.Full,
		items: [],
	} satisfies DocumentDiagnosticReport;
});

async function validateTextDocument(
	textDocument: TextDocument,
): Promise<Diagnostic[]> {
	const { runMarkuplintAgainstTemplate } = await import(
		"ngx-html-bridge-markuplint"
	);
	const results = await runMarkuplintAgainstTemplate(
		textDocument.getText(),
		textDocument.uri.replace("file://", ""),
	);
	const diagnostics: Diagnostic[] = [];
	const resultsWithViolations = results.filter(
		(result) => !!result && !!result.violations && result.violations.length > 0,
	);
	for (const result of resultsWithViolations) {
		let formattedHtml = result.variation.plain;
		try {
			formattedHtml = await format(formattedHtml, { parser: "html" });
		} catch {
			// If prettier fails to format HTML, no big deal. Just continue.
		}

		result.violations.forEach((violation) => {
			const diagnostic = createDiagnosticsFromViolation(
				textDocument,
				violation,
				formattedHtml,
			);
			diagnostics.push(diagnostic);
		});
	}
	return diagnostics;
}

documents.listen(connection);
connection.listen();

const convertToMarkuplintSeverityToDiagnosticSeverity = (
	severity: "info" | "warning" | "error",
): DiagnosticSeverity => {
	if (severity === "info") {
		return 3;
	}

	if (severity === "warning") {
		return 2;
	}

	if (severity === "error") {
		return 1;
	}

	// Should never happen
	return 4;
};

const createDiagnosticsFromViolation = (
	textDocument: TextDocument,
	violation: BridgeMLResultInfo["violations"][0],
	formattedHtml: string,
): Diagnostic => {
	const start = textDocument.positionAt(violation.startOffset);
	const end = textDocument.positionAt(violation.endOffset);
	const range = { start, end };
	return {
		range,
		severity: convertToMarkuplintSeverityToDiagnosticSeverity(
			violation.severity,
		),
		message: `${violation.message}`,
		source: `ngx-markuplint(${violation.ruleId})`,
		relatedInformation: [
			{
				message: `
${formattedHtml}
            `,
				location: {
					uri: textDocument.uri,
					range,
				},
			},
		],
	};
};
