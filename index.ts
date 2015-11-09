/// <reference path="./typings/tsd" />

import fs = require('fs');
import mkdirp = require('mkdirp');
import os = require('os');
import pathUtil = require('path');
import Promise = require('bluebird');
import ts = require('typescript');

interface Options {
	baseDir: string;
	files: string[];
	excludes?: string[];
	externs?: string[];
	eol?: string;
	includes?: string[];
	indent?: string;
	main?: string;
	name: string;
	out: string;
	target?: ts.ScriptTarget;
}

var filenameToMid:(filename: string) => string = (function () {
	if (pathUtil.sep === '/') {
		return function (filename: string) {
			return filename;
		};
	}
	else {
		var separatorExpression = new RegExp(pathUtil.sep.replace('\\', '\\\\'), 'g');
		return function (filename: string) {
			return filename.replace(separatorExpression, '/');
		};
	}
})();

function getError(diagnostics: ts.Diagnostic[]) {
	var message = 'Declaration generation failed';

	diagnostics.forEach(function (diagnostic) {
		var position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);

		message +=
			`\n${diagnostic.file.fileName}(${position.line + 1},${position.character + 1}): ` +
			`error TS${diagnostic.code}: ${diagnostic.messageText}`;
	});

	var error = new Error(message);
	error.name = 'EmitterError';
	return error;
}

function getFilenames(baseDir: string, files:string[]): string[] {
	return files.map(function (filename) {
		var resolvedFilename = pathUtil.resolve(filename);
		if (resolvedFilename.indexOf(baseDir) === 0) {
			return resolvedFilename;
		}

		return pathUtil.resolve(baseDir, filename);
	});
}

function processTree(sourceFile: ts.SourceFile, replacer:(node: ts.Node, parent: ts.Node) => string): string {
	var code = '';
	var cursorPosition = 0;

	function skip(node: ts.Node) {
		cursorPosition = node.end;
	}

	function readThrough(node: ts.Node) {
		code += sourceFile.text.slice(cursorPosition, node.pos);
		cursorPosition = node.pos;
	}

	function visit(node: ts.Node, parent: ts.Node) {
		readThrough(node);

		var replacement = replacer(node, parent);

		if (replacement != null) {
			code += replacement;
			skip(node);
		}
		else {
			parent = node;
			ts.forEachChild(node, (node) => {visit(node, parent)});
		}
	}

	visit(sourceFile, null);
	code += sourceFile.text.slice(cursorPosition);

	return code;
}

export function generate(options: Options, sendMessage: (message: string) => void = function () {}) {
	var baseDir = pathUtil.resolve(options.baseDir);
	var eol = options.eol || os.EOL;
	var nonEmptyLineStart = new RegExp(eol + '(?!' + eol + '|$)', 'g');
	var indent = options.indent === undefined ? '\t' : options.indent;
	var target = options.target || ts.ScriptTarget.Latest;
	var compilerOptions: ts.CompilerOptions = {
		declaration: true,
		module: ts.ModuleKind.CommonJS,
		target: target
	};

	var filenames = getFilenames(baseDir, options.files);
	var excludesMap: { [filename: string]: boolean; } = {};
	options.excludes && options.excludes.forEach(function (filename) {
		excludesMap[filenameToMid(pathUtil.resolve(baseDir, filename))] = true;
	});

	mkdirp.sync(pathUtil.dirname(options.out));
	var output = fs.createWriteStream(options.out, { mode: parseInt('644', 8) });
	var outputRef: fs.WriteStream;
	var outputString = '';
	var outputRefPath: string;
	var outputRefString = '';
	var wroteToOutputRef = false;

	if(options.out.slice(-5) === '.d.ts') {
		outputRefPath = options.out.slice(0, -5) + '.ref.d.ts';
		outputRef = fs.createWriteStream(outputRefPath, { mode: parseInt('644', 8) });
	}

	var host = ts.createCompilerHost(compilerOptions);
	var program = ts.createProgram(filenames, compilerOptions, host);

	function writeFile(filename: string, data: string, writeByteOrderMark: boolean) {
		// Compiler is emitting the non-declaration file, which we do not care about
		if (filename.slice(-5) !== '.d.ts') {
			return;
		}

		writeDeclaration(ts.createSourceFile(filename, data, target, true));
	}

	return new Promise<void>(function (resolve, reject) {
		var closeResolver: () => void = () => { resolve(undefined); };

		output.on('close', closeResolver);
		output.on('error', reject);

		if (options.externs) {
			options.externs.forEach(function (path: string) {
				sendMessage(`Writing external dependency ${path}`);
				outputString += `/// <reference path="${path}" />` + eol
			});
		}

		program.getSourceFiles().some(function (sourceFile) {
			// Source file is a default library, or other dependency from another project, that should not be included in
			// our bundled output
			if (pathUtil.normalize(sourceFile.fileName).indexOf(baseDir) !== 0) {
				return;
			}

			if (excludesMap[filenameToMid(pathUtil.normalize(sourceFile.fileName))]) {
				return;
			}

			sendMessage(`Processing ${sourceFile.fileName}`);

			// Source file is already a declaration file so should does not need to be pre-processed by the emitter
			if (sourceFile.fileName.slice(-5) === '.d.ts') {
				writeDeclaration(sourceFile);
				return;
			}

			var emitOutput = program.emit(sourceFile, writeFile);
			if (emitOutput.emitSkipped || emitOutput.diagnostics.length > 0) {
				reject(getError(
					emitOutput.diagnostics
						.concat(program.getSemanticDiagnostics(sourceFile))
						.concat(program.getSyntacticDiagnostics(sourceFile))
						.concat(program.getDeclarationDiagnostics(sourceFile))
				));

				return true;
			}
		});

		if (options.main) {
			outputString += `declare module '${options.name}' {` + eol + indent;
			outputString += `import main = require('${options.main}');` + eol + indent;
			outputString += 'export = main;' + eol;
			outputString += '}' + eol;
			sendMessage(`Aliased main module ${options.name} to ${options.main}`);
		}

		if(wroteToOutputRef) {
			outputString = (`/// <reference path="${outputRefPath}" />` + eol) + outputString;
		}

		output.write(outputString);

		// output.end() will complete our promise, if we need to delete an empty outputRef file then don't complete
		// until unlink has completed, otherwise complete now.
		if(outputRef) {
			if(wroteToOutputRef) {
				outputRef.write(outputRefString);
			}

			outputRef.end();

			if(!wroteToOutputRef) {
				fs.unlink(outputRefPath, (err: NodeJS.ErrnoException) => {
					if(err) {
						sendMessage(`Error on unlink of \'"${outputRefPath}"\': "${err}"`);

						// Don't want our close listener to call resolve, as we are about to call reject
						output.removeListener('close', closeResolver);
						output.end();
						reject(err);
					}
					else {
						output.end();
					}
				});
			}
			else {
				output.end();
			}
		}
		else {
			output.end();
		}
	});

	function writeDeclaration(declarationFile: ts.SourceFile) {
		var filename = declarationFile.fileName;
		var sourceModuleId = options.name + filenameToMid(filename.slice(baseDir.length, -5));

		if (declarationFile.externalModuleIndicator) {
			if(outputRefPath) {
				declarationFile.referencedFiles.forEach((refPath) => {
					var refFullPath = pathUtil.resolve(
						pathUtil.dirname(pathUtil.resolve(baseDir, filename)),
						refPath.fileName
					);

					var refRelPath = filenameToMid(pathUtil.relative(
						pathUtil.dirname(outputRefPath),
						refFullPath
					));

					outputRefString += `/// <reference path="${refRelPath}" />` + eol;
					wroteToOutputRef = true;
				});
			}
			outputString += 'declare module \'' + sourceModuleId + '\' {' + eol + indent;

			var content = processTree(declarationFile, function (node, parent) {
				if (node.kind === ts.SyntaxKind.ExternalModuleReference) {
					var expression = <ts.LiteralExpression> (<ts.ExternalModuleReference> node).expression;

					if (expression.text.charAt(0) === '.') {
						return ' require(\'' + filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), expression.text)) + '\')';
					}
				}
				else if (node.kind === ts.SyntaxKind.DeclareKeyword) {
					return '';
				}
				else if (
					node.kind === ts.SyntaxKind.StringLiteral &&
					(parent.kind === ts.SyntaxKind.ExportDeclaration || parent.kind === ts.SyntaxKind.ImportDeclaration)
				) {
					var text = (<ts.StringLiteral> node).text;
					if (text.charAt(0) === '.') {
						return ` '${filenameToMid(pathUtil.join(pathUtil.dirname(sourceModuleId), text))}'`;
					}
				}
			});

			outputString += content.replace(nonEmptyLineStart, '$&' + indent);
			outputString += eol + '}' + eol;
		}
		else {
			outputString += declarationFile.text;
		}
	}
}
