/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import type {
	Diagnostic,
	InitializeParams,
	DocumentDiagnosticReport,
	DiagnosticSeverity,
} from "vscode-languageserver/node";

import { resolve } from "node:path";
import {
	TextDocuments,
	TextDocumentSyncKind,
	createConnection,
	DidChangeConfigurationNotification,
	DocumentDiagnosticReportKind,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import type { Range } from "vscode-languageserver-textdocument";

import type { Config, OverrideConfig, Violation } from "@markuplint/ml-config";

import { format } from "prettier";

const connection = createConnection();

const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);

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

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(
			DidChangeConfigurationNotification.type,
			undefined,
		);
	}
});

interface MarkuplintConfig {
	markuplintConfig: Config;
}
const defaultSettings: MarkuplintConfig = {
	markuplintConfig: {
		extends: ["markuplint:recommended"],
	},
};
let globalSettings: MarkuplintConfig = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<MarkuplintConfig>>();

connection.onDidChangeConfiguration((change) => {
	if (hasConfigurationCapability) {
		documentSettings.clear();
	} else {
		globalSettings = change.settings.ngxMarkuplint || defaultSettings;
	}
	connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<MarkuplintConfig> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: "ngxMarkuplint",
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
	documentSettings.delete(e.document.uri);
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

const getOverridesConfig = (
	config: Config,
	textDocument: TextDocument,
): OverrideConfig => {
	const overrides = config.overrides;
	if (!overrides) {
		return {};
	}

	const currentFile = textDocument.uri.replace("file://", "");
	for (const overridesKey of Object.keys(overrides)) {
		const resolvedFile = resolve(overridesKey);
		if (resolvedFile === currentFile) {
			return overrides[overridesKey];
		}
	}

	return {};
};

async function validateTextDocument(
	textDocument: TextDocument,
): Promise<Diagnostic[]> {
	const { markuplintConfig } = await getDocumentSettings(textDocument.uri);
	const overridesConfig = getOverridesConfig(markuplintConfig, textDocument);

	const { bridgeTemplate } = await import("ngx-html-bridge");
	const { MLEngine } = await import("markuplint");
	const htmls = bridgeTemplate(
		textDocument.getText(),
		textDocument.uri.replace("file://", ""),
	);

	const diagnostics = new Map<string, Diagnostic>();
	for (const html of htmls) {
		const engine = await MLEngine.fromCode(html, {
			config: {
				...markuplintConfig,
				...overridesConfig,
			},
			ignoreExt: true,
		});
		const result = await engine.exec();
		const violations = result?.violations;
		if (violations === undefined) {
			continue;
		}

		if (violations.length === 0) {
			continue;
		}

		for (const violation of violations) {
			const range = extractRange(textDocument, violation, html);
			const diagnostic: Diagnostic = {
				severity: convertToMarkuplintSeverityToDiagnosticSeverity(
					violation.severity,
				),
				range,
				message: `${violation.message}`,
				source: `ngx-markuplint(${violation.ruleId})`,
				relatedInformation: [
					{
						message: `
${await format(removeNgxHTMLBridgeAttributes(html), { parser: "html" })}
            `,
						location: {
							uri: textDocument.uri,
							range,
						},
					},
				],
			};
			diagnostics.set(
				JSON.stringify({ range, message: violation.message }),
				diagnostic,
			);
		}
	}

	return [...diagnostics.values()];
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

const extractRange = (
	textDocument: TextDocument,
	violation: Violation,
	html: string,
): Range => {
	// Based on the assumption raw is either HTML or its attribute definition part
	// e.g. It's either something like "<img/>" or "aria-label=\"lagel\""
	// TODO: Verify this assumption
	const offsets =
		extractOffsetsFromHTMLRaw(violation.raw) ||
		extractOffsetsFromAttributeRaw(html, violation);
	const start = offsets
		? textDocument.positionAt(offsets.startOffset)
		: {
				line: violation.line - 1,
				character: violation.col - 1,
			};
	const end = offsets
		? textDocument.positionAt(offsets.endOffset)
		: {
				line: violation.line - 1,
				character: violation.col - 1,
			};
	return { start, end };
};

const extractOffsetsFromHTMLRaw = (
	raw: string,
): { startOffset: number; endOffset: number } | null => {
	const regex =
		/data-ngx-html-bridge-start-offset="(\d+)"\s+data-ngx-html-bridge-end-offset="(\d+)"/;
	const match = raw.match(regex);

	if (match) {
		const startOffset = Number.parseInt(match[1], 10);
		const endOffset = Number.parseInt(match[2], 10);
		return { startOffset, endOffset };
	}

	return null;
};

const extractOffsetsFromAttributeRaw = (
	html: string,
	violation: Violation,
): { startOffset: number; endOffset: number } | null => {
	const { raw, col } = violation;
	const rawIndex = html.indexOf(raw);
	if (rawIndex === -1) {
		return null;
	}

	// The source span of each attribute (e.g., data-ngx-html-bridge-attr-name-start/end-offset) appears immediately after the attribute definition.
	// Additionally, the same attribute can appear multiple times in the HTML.
	// Therefore, we need the string immediately following the attribute definition and should take the first occurrence of data-ngx-html-bridge-attr-name-start/end-offset from it.
	const htmlAfterRaw = html.substring(col + raw.length, html.length);
	html.substring(rawIndex + raw.length);
	const attrName = raw.split("=")[0].trim();
	const rawOffsetRegex = new RegExp(
		`data-ngx-html-bridge-${attrName}-start-offset="(\\d+)"\\s+data-ngx-html-bridge-${attrName}-end-offset="(\\d+)"`,
		"i",
	);
	const match = htmlAfterRaw.match(rawOffsetRegex);

	const rawStartOffset = match ? Number.parseInt(match[1], 10) : 0;
	const rawEndOffset = match ? Number.parseInt(match[2], 10) : 0;

	return {
		startOffset: rawStartOffset,
		endOffset: rawEndOffset,
	};
};

const removeNgxHTMLBridgeAttributes = (html: string): string => {
	const regex = /\s*data-ngx-html-bridge-[a-z-]+="[^"]*"/g;
	return html.replace(regex, "");
};
