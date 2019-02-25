// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../../common/extensions';

import { Observable } from 'rxjs/Observable';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc';
import * as vsls from 'vsls/vscode';

import { ILiveShareApi } from '../../../common/application/types';
import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, ILogger } from '../../../common/types';
import { Identifiers, LiveShare, LiveShareCommands } from '../../constants';
import { ICell, IDataScience, IJupyterSessionManager, INotebookServer, InterruptResult } from '../../types';
import { JupyterServerBase } from '../jupyterServer';
import { LiveShareParticipantHost } from './liveShareParticipantMixin';
import { IRoleBasedObject } from './roleBasedFactory';
import { IResponseMapping, IServerResponse, ServerResponseType, IExecuteObservableResponse } from './types';
import { ResponseQueue } from './responseQueue';
import { IExecuteInfo } from '../../historyTypes';

// tslint:disable:no-any

export class HostJupyterServer
    extends LiveShareParticipantHost(JupyterServerBase, LiveShare.JupyterServerSharedService)
    implements IRoleBasedObject, INotebookServer {
    private responseQueue : ResponseQueue = new ResponseQueue();
    private requestLog : Map<string, number> = new Map<string, number>();
    private catchupPendingCount : number = 0;
    private disposed = false;
    constructor(
        liveShare: ILiveShareApi,
        dataScience: IDataScience,
        logger: ILogger,
        disposableRegistry: IDisposableRegistry,
        asyncRegistry: IAsyncDisposableRegistry,
        configService: IConfigurationService,
        sessionManager: IJupyterSessionManager) {
        super(liveShare, dataScience, logger, disposableRegistry, asyncRegistry, configService, sessionManager);
    }

    public async dispose(): Promise<void> {
        if (!this.disposed) {
            this.disposed = true;
            await super.dispose();
            const api = await this.api;
            return this.onDetach(api) ;
        }
    }

    public async onDetach(api: vsls.LiveShare | null) : Promise<void> {
        if (api) {
            return api.unshareService(LiveShare.JupyterServerSharedService);
        }
    }

    public async onAttach(api: vsls.LiveShare | null) : Promise<void> {
        if (api && !this.disposed) {
            const service = await this.waitForService();

            // Attach event handlers to different requests
            if (service) {
                // Requests return arrays
                service.onRequest(LiveShareCommands.syncRequest, (args: any[], cancellation: CancellationToken) => this.onSync());
                service.onRequest(LiveShareCommands.getSysInfo, (args:  any[], cancellation: CancellationToken) => this.onGetSysInfoRequest(cancellation));
                service.onRequest(LiveShareCommands.restart, (args:  any[], cancellation: CancellationToken) => this.onRestartRequest(cancellation))
                service.onRequest(LiveShareCommands.interrupt, (args:  any[], cancellation: CancellationToken) => this.onInterruptRequest(args.length > 0 ? args[0] as number : LiveShare.InterruptDefaultTimeout, cancellation))

                // Notifications are always objects.
                service.onNotify(LiveShareCommands.catchupRequest, (args: object) => this.onCatchupRequest(args));
                service.onNotify(LiveShareCommands.executeObservable, (args: object) => this.onExecuteObservableRequest(args));
            }
        }
    }

    public async onPeerChange(ev: vsls.PeersChangeEvent) : Promise<void> {
        // Keep track of the number of guests that need to do a catchup request
        this.catchupPendingCount +=
            ev.added.filter(e => e.role === vsls.Role.Guest).length -
            ev.removed.filter(e => e.role === vsls.Role.Guest).length;
    }

    public executeObservable(code: string, file: string, line: number, id: string): Observable<ICell[]> {
        try {
            // See if this has already been asked for not
            if (this.requestLog.has(id)) {
                // Create a dummy observable out of the responses as they come in.
                return this.responseQueue.waitForObservable(code, file, line, id);
            } else {
                // Otherwise save this request
                this.requestLog.set(id, Date.now());
                const inner = super.executeObservable(code, file, line, id);

                // Cleanup old requests
                const now = Date.now();
                for (let [k, val] of this.requestLog) {
                    if (now - val > LiveShare.ResponseLifetime) {
                        this.requestLog.delete(k);
                    }
                }

                // Wrap the observable returned so we can listen to it too
                return this.wrapObservableResult(code, inner, id);
            }
        } catch (exc) {
            this.postException(exc);
            throw exc;
        }

    }

    public async restartKernel(): Promise<void> {
        try {
            await super.restartKernel();
        } catch (exc) {
            this.postException(exc);
            throw exc;
        }
    }

    public async interruptKernel(timeoutMs: number): Promise<InterruptResult> {
        try {
            const time = Date.now();
            const result = await super.interruptKernel(timeoutMs);
            return result;
        } catch (exc) {
            this.postException(exc);
            throw exc;
        }
    }

    private translateCellForGuest(cell: ICell) : ICell {
        const copy = {...cell};
        if (this.role === vsls.Role.Host && this.finishedApi && copy.file !== Identifiers.EmptyFileName) {
            copy.file = this.finishedApi.convertLocalUriToShared(vscode.Uri.file(copy.file)).fsPath;
        }
        return copy;
    }

    private onSync() : Promise<any> {
        return Promise.resolve(true);
    }

    private onGetSysInfoRequest(cancellation: CancellationToken) : Promise<any> {
        // Get the sys info from our local server
        return super.getSysInfo();
    }

    private onRestartRequest(cancellation: CancellationToken) : Promise<any> {
        // Just call the base
        return super.restartKernel();
    }
    private onInterruptRequest(timeout: number, cancellation: CancellationToken) : Promise<any> {
        // Just call the base
        return super.interruptKernel(timeout);
    }

    private async onCatchupRequest(args: object) : Promise<void> {
        if (args.hasOwnProperty('since')) {
            const service = await this.waitForService();
            if (service) {
                // Send results for all responses that are left.
                this.responseQueue.send(service);

                // Eliminate old responses if possible.
                this.catchupPendingCount -= 1;
                if (this.catchupPendingCount <= 0) {
                    this.responseQueue.clear();
                }
            }
        }
    }

    private onExecuteObservableRequest(args: object) {
        // See if we started this execute or not already.
        if (args.hasOwnProperty('code')) {
            const obj = args as IExecuteInfo;
            if (!this.requestLog.has(obj.id)) {
                // Convert the file name
                const uri = vscode.Uri.parse(`vsls:${obj.file}`);
                const file = this.finishedApi ? this.finishedApi.convertLocalUriToShared(uri).fsPath : obj.file;

                // Just call the execute. Locally we won't listen, but if an actual call comes in for the same
                // request, it will use the saved responses.
                this.execute(obj.code, file, obj.line, obj.id).ignoreErrors();
            }
        }
    }

    private wrapObservableResult(code: string, observable: Observable<ICell[]>, id: string) : Observable<ICell[]> {
        return new Observable(subscriber => {
            let pos = 0;

            // Listen to all of the events on the observable passed in.
            observable.subscribe(cells => {
                // Forward to the next listener
                subscriber.next(cells);

                // Send across to the guest side
                try {
                    const translated = cells.map(c => this.translateCellForGuest(c));
                    this.postObservableNext(code, pos, translated, id);
                    pos += 1;
                } catch (e) {
                    subscriber.error(e);
                    this.postException(e);
                }
            },
            e => {
                subscriber.error(e);
                this.postException(e);
            },
            () => {
                subscriber.complete();
                this.postObservableComplete(code, pos, id);
            });
        });
    }

    private postObservableNext(code: string, pos: number, cells: ICell[], id: string) {
        this.postResult(ServerResponseType.ExecuteObservable, { code, pos, type: ServerResponseType.ExecuteObservable, cells, id, time: Date.now() });
    }

    private postObservableComplete(code: string, pos: number, id: string) {
        this.postResult(ServerResponseType.ExecuteObservable, { code, pos, type: ServerResponseType.ExecuteObservable, cells: undefined, id, time: Date.now() });
    }

    private postException(exc: any) {
        this.postResult(ServerResponseType.Exception, {type: ServerResponseType.Exception, time: Date.now(), message: exc.toString()});
    }

    private postResult<R extends IResponseMapping, T extends keyof R>(type: T, result: R[T]) : void {
            const typedResult = ((result as any) as IServerResponse);
            if (typedResult) {
                this.waitForService().then(s => {
                    if (s) {
                        s.notify(LiveShareCommands.serverResponse, typedResult);
                    }
                }).ignoreErrors();

                // Need to also save in memory for those guests that are in the middle of starting up
                this.responseQueue.push(typedResult);
            }
    }
}
