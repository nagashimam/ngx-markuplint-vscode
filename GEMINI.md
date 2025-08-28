# ngx-markuplint-vscode

ngx-markuplint-vscode is VSCode extension for integrating [Markuplint](https://markuplint.dev/) with Angular app. It runs Markuplint against result of running [ngx-html-bridge](https://github.com/nagashimam/ngx-html-bridge) for Angular templates.

It consists of 2 parts: LSP server(`server/src/server.ts`) and its client(`client/src/extension.ts`). The former executes Markuplint, and the latter configures and launches the former.
