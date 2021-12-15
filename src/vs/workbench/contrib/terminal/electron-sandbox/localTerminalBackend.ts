/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { Schemas } from 'vs/base/common/network';
import { IProcessEnvironment, isMacintosh, isWindows, OperatingSystem } from 'vs/base/common/platform';
import { withNullAsUndefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILabelService } from 'vs/platform/label/common/label';
import { ILogService } from 'vs/platform/log/common/log';
import { INotificationHandle, INotificationService, IPromptChoice, Severity } from 'vs/platform/notification/common/notification';
import { Registry } from 'vs/platform/registry/common/platform';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { IProcessPropertyMap, IShellLaunchConfig, ITerminalChildProcess, ITerminalEnvironment, ITerminalsLayoutInfo, ITerminalsLayoutInfoById, ProcessPropertyType, TerminalSettingId, TitleEventSource } from 'vs/platform/terminal/common/terminal';
import { IGetTerminalLayoutInfoArgs, IProcessDetails, ISetTerminalLayoutInfoArgs, ITerminalEnvironmentVariableCollections } from 'vs/platform/terminal/common/terminalProcess';
import { ILocalPtyService } from 'vs/platform/terminal/electron-sandbox/terminal';
import { IWorkspaceContextService, IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { ICompleteTerminalConfiguration, ITerminalBackend, ITerminalBackendRegistry, ITerminalConfiguration, TerminalExtensions, TERMINAL_CONFIG_SECTION } from 'vs/workbench/contrib/terminal/common/terminal';
import { TerminalStorageKeys } from 'vs/workbench/contrib/terminal/common/terminalStorageKeys';
import { LocalPty } from 'vs/workbench/contrib/terminal/electron-sandbox/localPty';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { IShellEnvironmentService } from 'vs/workbench/services/environment/electron-sandbox/shellEnvironmentService';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import * as terminalEnvironment from 'vs/workbench/contrib/terminal/common/terminalEnvironment';
import { IProductService } from 'vs/platform/product/common/productService';
import { EditorResourceAccessor, SideBySideEditor } from 'vs/workbench/common/editor';
import { serializeEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariableShared';
import * as path from 'vs/base/common/path';
import { AbstractVariableResolverService } from 'vs/workbench/services/configurationResolver/common/variableResolver';
import { IEnvironmentVariableService } from 'vs/workbench/contrib/terminal/common/environmentVariable';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';

class CustomVariableResolver extends AbstractVariableResolverService {
	constructor(
		env: IProcessEnvironment,
		workspaceFolders: IWorkspaceFolder[],
		activeFileResource: URI | undefined,
		resolvedVariables: { [name: string]: string; }
	) {
		super({
			getFolderUri: (folderName: string): URI | undefined => {
				const found = workspaceFolders.filter(f => f.name === folderName);
				if (found && found.length > 0) {
					return found[0].uri;
				}
				return undefined;
			},
			getWorkspaceFolderCount: (): number => {
				return workspaceFolders.length;
			},
			getConfigurationValue: (folderUri: URI, section: string): string | undefined => {
				return resolvedVariables[`config:${section}`];
			},
			getExecPath: (): string | undefined => {
				return env['VSCODE_EXEC_PATH'];
			},
			getAppRoot: (): string | undefined => {
				return env['VSCODE_CWD'];
			},
			getFilePath: (): string | undefined => {
				if (activeFileResource) {
					return path.normalize(activeFileResource.fsPath);
				}
				return undefined;
			},
			getSelectedText: (): string | undefined => {
				return resolvedVariables['selectedText'];
			},
			getLineNumber: (): string | undefined => {
				return resolvedVariables['lineNumber'];
			}
		}, undefined, Promise.resolve(env));
	}
}


export class LocalTerminalBackendContribution implements IWorkbenchContribution {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ITerminalService terminalService: ITerminalService
	) {
		const backend = instantiationService.createInstance(LocalTerminalBackend, undefined);
		Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend).registerTerminalBackend(backend);
		terminalService.handleNewRegisteredBackend(backend);
	}
}

class LocalTerminalBackend extends Disposable implements ITerminalBackend {
	private readonly _ptys: Map<number, LocalPty> = new Map();
	private _isPtyHostUnresponsive: boolean = false;

	private readonly _onPtyHostUnresponsive = this._register(new Emitter<void>());
	readonly onPtyHostUnresponsive = this._onPtyHostUnresponsive.event;
	private readonly _onPtyHostResponsive = this._register(new Emitter<void>());
	readonly onPtyHostResponsive = this._onPtyHostResponsive.event;
	private readonly _onPtyHostRestart = this._register(new Emitter<void>());
	readonly onPtyHostRestart = this._onPtyHostRestart.event;
	private readonly _onDidRequestDetach = this._register(new Emitter<{ requestId: number, workspaceId: string, instanceId: number }>());
	readonly onDidRequestDetach = this._onDidRequestDetach.event;

	constructor(
		readonly remoteAuthority: string | undefined,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@ILocalPtyService private readonly _localPtyService: ILocalPtyService,
		@ILabelService private readonly _labelService: ILabelService,
		@INotificationService notificationService: INotificationService,
		@IShellEnvironmentService private readonly _shellEnvironmentService: IShellEnvironmentService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationResolverService configurationResolverService: IConfigurationResolverService,
		@IHistoryService historyService: IHistoryService,
		@IConfigurationService configurationService: IConfigurationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IProductService private readonly _productService: IProductService,
		@IConfigurationResolverService private readonly _resolverService: IConfigurationResolverService,
		@IEnvironmentVariableService private readonly _environmentVariableService: IEnvironmentVariableService,
		@IHistoryService private readonly _historyService: IHistoryService,
		@IEditorService private readonly _editorService: IEditorService

	) {
		super();

		// Attach process listeners
		this._localPtyService.onProcessData(e => this._ptys.get(e.id)?.handleData(e.event));
		this._localPtyService.onDidChangeProperty(e => this._ptys.get(e.id)?.handleDidChangeProperty(e.property));
		this._localPtyService.onProcessExit(e => {
			const pty = this._ptys.get(e.id);
			if (pty) {
				pty.handleExit(e.event);
				this._ptys.delete(e.id);
			}
		});
		this._localPtyService.onProcessReady(e => this._ptys.get(e.id)?.handleReady(e.event));
		this._localPtyService.onProcessReplay(e => this._ptys.get(e.id)?.handleReplay(e.event));
		this._localPtyService.onProcessOrphanQuestion(e => this._ptys.get(e.id)?.handleOrphanQuestion());
		this._localPtyService.onDidRequestDetach(e => this._onDidRequestDetach.fire(e));

		// Attach pty host listeners
		if (this._localPtyService.onPtyHostExit) {
			this._register(this._localPtyService.onPtyHostExit(() => {
				this._logService.error(`The terminal's pty host process exited, the connection to all terminal processes was lost`);
			}));
		}
		let unresponsiveNotification: INotificationHandle | undefined;
		if (this._localPtyService.onPtyHostStart) {
			this._register(this._localPtyService.onPtyHostStart(() => {
				this._logService.info(`ptyHost restarted`);
				this._onPtyHostRestart.fire();
				unresponsiveNotification?.close();
				unresponsiveNotification = undefined;
				this._isPtyHostUnresponsive = false;
			}));
		}
		if (this._localPtyService.onPtyHostUnresponsive) {
			this._register(this._localPtyService.onPtyHostUnresponsive(() => {
				const choices: IPromptChoice[] = [{
					label: localize('restartPtyHost', "Restart pty host"),
					run: () => this._localPtyService.restartPtyHost!()
				}];
				unresponsiveNotification = notificationService.prompt(Severity.Error, localize('nonResponsivePtyHost', "The connection to the terminal's pty host process is unresponsive, the terminals may stop working."), choices);
				this._isPtyHostUnresponsive = true;
				this._onPtyHostUnresponsive.fire();
			}));
		}
		if (this._localPtyService.onPtyHostResponsive) {
			this._register(this._localPtyService.onPtyHostResponsive(() => {
				if (!this._isPtyHostUnresponsive) {
					return;
				}
				this._logService.info('The pty host became responsive again');
				unresponsiveNotification?.close();
				unresponsiveNotification = undefined;
				this._isPtyHostUnresponsive = false;
				this._onPtyHostResponsive.fire();
			}));
		}
		if (this._localPtyService.onPtyHostRequestResolveVariables) {
			this._register(this._localPtyService.onPtyHostRequestResolveVariables(async e => {
				// Only answer requests for this workspace
				if (e.workspaceId !== this._workspaceContextService.getWorkspace().id) {
					return;
				}
				const activeWorkspaceRootUri = historyService.getLastActiveWorkspaceRoot(Schemas.file);
				const lastActiveWorkspaceRoot = activeWorkspaceRootUri ? withNullAsUndefined(this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri)) : undefined;
				const resolveCalls: Promise<string>[] = e.originalText.map(t => {
					return configurationResolverService.resolveAsync(lastActiveWorkspaceRoot, t);
				});
				const result = await Promise.all(resolveCalls);
				this._localPtyService.acceptPtyHostResolvedVariables?.(e.requestId, result);
			}));
		}

		// Listen for config changes
		const initialConfig = configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
		for (const match of Object.keys(initialConfig.autoReplies)) {
			this._localPtyService.installAutoReply(match, initialConfig.autoReplies[match]);
		}
		// TODO: Could simplify update to a single call
		this._register(configurationService.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(TerminalSettingId.AutoReplies)) {
				this._localPtyService.uninstallAllAutoReplies();
				const config = configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
				for (const match of Object.keys(config.autoReplies)) {
					await this._localPtyService.installAutoReply(match, config.autoReplies[match]);
				}
			}
		}));
	}

	async requestDetachInstance(workspaceId: string, instanceId: number): Promise<IProcessDetails | undefined> {
		return this._localPtyService.requestDetachInstance(workspaceId, instanceId);
	}

	async acceptDetachInstanceReply(requestId: number, persistentProcessId?: number): Promise<void> {
		if (!persistentProcessId) {
			this._logService.warn('Cannot attach to feature terminals, custom pty terminals, or those without a persistentProcessId');
			return;
		}
		return this._localPtyService.acceptDetachInstanceReply(requestId, persistentProcessId);
	}

	async persistTerminalState(): Promise<void> {
		const ids = Array.from(this._ptys.keys());
		const serialized = await this._localPtyService.serializeTerminalState(ids);
		this._storageService.store(TerminalStorageKeys.TerminalBufferState, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async updateTitle(id: number, title: string, titleSource: TitleEventSource): Promise<void> {
		await this._localPtyService.updateTitle(id, title, titleSource);
	}

	async updateIcon(id: number, icon: URI | { light: URI; dark: URI } | { id: string, color?: { id: string } }, color?: string): Promise<void> {
		await this._localPtyService.updateIcon(id, icon, color);
	}

	updateProperty<T extends ProcessPropertyType>(id: number, property: ProcessPropertyType, value: IProcessPropertyMap[T]): Promise<void> {
		return this._localPtyService.updateProperty(id, property, value);
	}

	async createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		unicodeVersion: '6' | '11',
		env: IProcessEnvironment,
		windowsEnableConpty: boolean,
		shouldPersist: boolean
	): Promise<ITerminalChildProcess> {

		const executableEnv = await this._shellEnvironmentService.getShellEnv();
		const terminalConfig = this._configurationService.getValue<ITerminalConfiguration>(TERMINAL_CONFIG_SECTION);
		const configuration: ICompleteTerminalConfiguration = {
			'terminal.integrated.automationShell.windows': this._configurationService.getValue(TerminalSettingId.AutomationShellWindows) as string,
			'terminal.integrated.automationShell.osx': this._configurationService.getValue(TerminalSettingId.AutomationShellMacOs) as string,
			'terminal.integrated.automationShell.linux': this._configurationService.getValue(TerminalSettingId.AutomationShellLinux) as string,
			'terminal.integrated.shell.windows': this._configurationService.getValue(TerminalSettingId.ShellWindows) as string,
			'terminal.integrated.shell.osx': this._configurationService.getValue(TerminalSettingId.ShellMacOs) as string,
			'terminal.integrated.shell.linux': this._configurationService.getValue(TerminalSettingId.ShellLinux) as string,
			'terminal.integrated.shellArgs.windows': this._configurationService.getValue(TerminalSettingId.ShellArgsWindows) as string | string[],
			'terminal.integrated.shellArgs.osx': this._configurationService.getValue(TerminalSettingId.ShellArgsMacOs) as string | string[],
			'terminal.integrated.shellArgs.linux': this._configurationService.getValue(TerminalSettingId.ShellArgsLinux) as string | string[],
			'terminal.integrated.env.windows': this._configurationService.getValue(TerminalSettingId.EnvWindows) as ITerminalEnvironment,
			'terminal.integrated.env.osx': this._configurationService.getValue(TerminalSettingId.EnvMacOs) as ITerminalEnvironment,
			'terminal.integrated.env.linux': this._configurationService.getValue(TerminalSettingId.EnvLinux) as ITerminalEnvironment,
			'terminal.integrated.cwd': this._configurationService.getValue(TerminalSettingId.Cwd) as string,
			'terminal.integrated.detectLocale': terminalConfig.detectLocale
		};

		let baseEnv: IProcessEnvironment = { ...process.env };
		this._logService.trace('baseEnv', baseEnv);
		const envPlatformKey = isWindows ? 'terminal.integrated.env.windows' : (isMacintosh ? 'terminal.integrated.env.osx' : 'terminal.integrated.env.linux');
		const envFromConfig = configuration[envPlatformKey];

		const activeWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot();

		const resolvedVariables = Object.create(null);
		const lastActiveWorkspace = activeWorkspaceRootUri ? withNullAsUndefined(this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri)) : undefined;
		let allResolvedVariables: Map<string, string> | undefined = undefined;
		try {
			allResolvedVariables = (await this._resolverService.resolveAnyMap(lastActiveWorkspace, {
				shellLaunchConfig,
				configuration
			})).resolvedVariables;
		} catch (err) {
			this._logService.error(err);
		}
		if (allResolvedVariables) {
			for (const [name, value] of allResolvedVariables.entries()) {
				if (/^config:/.test(name) || name === 'selectedText' || name === 'lineNumber') {
					resolvedVariables[name] = value;
				}
			}
		}

		const envVariableCollections: ITerminalEnvironmentVariableCollections = [];
		for (const [k, v] of this._environmentVariableService.collections.entries()) {
			envVariableCollections.push([k, serializeEnvironmentVariableCollection(v.map)]);
		}

		const workspace = this._workspaceContextService.getWorkspace();
		const workspaceFolders = workspace.folders;
		const activeWorkspaceFolder = activeWorkspaceRootUri ? this._workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri) : null;
		const activeFileResource = EditorResourceAccessor.getOriginalUri(this._editorService.activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
			filterByScheme: [Schemas.file, Schemas.userData, Schemas.vscodeRemote]
		});
		const customVariableResolver = new CustomVariableResolver(baseEnv, workspaceFolders, activeFileResource, resolvedVariables);

		env = terminalEnvironment.createTerminalEnvironment(
			shellLaunchConfig,
			envFromConfig,
			terminalEnvironment.createVariableResolver(withNullAsUndefined(activeWorkspaceFolder), process.env, customVariableResolver),
			this._productService.version,
			configuration['terminal.integrated.detectLocale'],
			baseEnv
		);
		const id = await this._localPtyService.createProcess(shellLaunchConfig, cwd, cols, rows, unicodeVersion, env, executableEnv, windowsEnableConpty, shouldPersist, this._getWorkspaceId(), this._getWorkspaceName());
		const pty = this._instantiationService.createInstance(LocalPty, id, shouldPersist);
		this._ptys.set(id, pty);
		return pty;
	}

	async attachToProcess(id: number): Promise<ITerminalChildProcess | undefined> {
		try {
			await this._localPtyService.attachToProcess(id);
			const pty = this._instantiationService.createInstance(LocalPty, id, true);
			this._ptys.set(id, pty);
			return pty;
		} catch (e) {
			this._logService.trace(`Couldn't attach to process ${e.message}`);
		}
		return undefined;
	}

	async listProcesses(): Promise<IProcessDetails[]> {
		return this._localPtyService.listProcesses();
	}

	async reduceConnectionGraceTime(): Promise<void> {
		this._localPtyService.reduceConnectionGraceTime();
	}

	async getDefaultSystemShell(osOverride?: OperatingSystem): Promise<string> {
		return this._localPtyService.getDefaultSystemShell(osOverride);
	}

	async getProfiles(profiles: unknown, defaultProfile: unknown, includeDetectedProfiles?: boolean) {
		return this._localPtyService.getProfiles?.(this._workspaceContextService.getWorkspace().id, profiles, defaultProfile, includeDetectedProfiles) || [];
	}

	async getEnvironment(): Promise<IProcessEnvironment> {
		return this._localPtyService.getEnvironment();
	}

	async getShellEnvironment(): Promise<IProcessEnvironment> {
		return this._shellEnvironmentService.getShellEnv();
	}

	async getWslPath(original: string): Promise<string> {
		return this._localPtyService.getWslPath(original);
	}

	async setTerminalLayoutInfo(layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {
		const args: ISetTerminalLayoutInfoArgs = {
			workspaceId: this._getWorkspaceId(),
			tabs: layoutInfo ? layoutInfo.tabs : []
		};
		await this._localPtyService.setTerminalLayoutInfo(args);
		// Store in the storage service as well to be used when reviving processes as normally this
		// is stored in memory on the pty host
		this._storageService.store(TerminalStorageKeys.TerminalLayoutInfo, JSON.stringify(args), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
		const layoutArgs: IGetTerminalLayoutInfoArgs = {
			workspaceId: this._getWorkspaceId()
		};

		// Revive processes if needed
		const serializedState = this._storageService.get(TerminalStorageKeys.TerminalBufferState, StorageScope.WORKSPACE);
		if (serializedState) {
			try {
				await this._localPtyService.reviveTerminalProcesses(serializedState, Intl.DateTimeFormat().resolvedOptions().locale);
				this._storageService.remove(TerminalStorageKeys.TerminalBufferState, StorageScope.WORKSPACE);
				// If reviving processes, send the terminal layout info back to the pty host as it
				// will not have been persisted on application exit
				const layoutInfo = this._storageService.get(TerminalStorageKeys.TerminalLayoutInfo, StorageScope.WORKSPACE);
				if (layoutInfo) {
					await this._localPtyService.setTerminalLayoutInfo(JSON.parse(layoutInfo));
					this._storageService.remove(TerminalStorageKeys.TerminalLayoutInfo, StorageScope.WORKSPACE);
				}
			} catch {
				// no-op
			}
		}

		return this._localPtyService.getTerminalLayoutInfo(layoutArgs);
	}

	private _getWorkspaceId(): string {
		return this._workspaceContextService.getWorkspace().id;
	}

	private _getWorkspaceName(): string {
		return this._labelService.getWorkspaceLabel(this._workspaceContextService.getWorkspace());
	}
}
