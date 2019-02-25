// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import * as uuid from 'uuid/v4';
import { inject, injectable } from 'inversify';

import { IDisposableRegistry, IAsyncDisposable, IAsyncDisposableRegistry } from '../common/types';
import { IServiceContainer } from '../ioc/types';
import { IHistory, IHistoryProvider } from './types';
import { PostOffice } from './liveshare/postOffice';
import { ILiveShareApi } from '../common/application/types';
import { LiveShare, LiveShareCommands } from './constants';
import { Deferred, createDeferred } from '../common/utils/async';

@injectable()
export class HistoryProvider implements IHistoryProvider, IAsyncDisposable {

    private activeHistory : IHistory | undefined;
    private postOffice : PostOffice;
    private id: string;
    private pendingSyncs : { [key: string] : { waitable: Deferred<void>; count: number }} = {};
    constructor(
        @inject(ILiveShareApi) private liveShare: ILiveShareApi,
        @inject(IServiceContainer) private serviceContainer: IServiceContainer,
        @inject(IAsyncDisposableRegistry) asyncRegistry : IAsyncDisposableRegistry,
        @inject(IDisposableRegistry) private disposables: IDisposableRegistry) {
        asyncRegistry.push(this);

        // Create a post office so we can make sure history windows are created at the same time
        // on both sides.
        this.postOffice = new PostOffice(LiveShare.HistoryProviderService, liveShare);

        // Listen for peer changes
        this.postOffice.peerCountChanged((n) => this.onPeerCountChanged(n));

        // Listen for messages so we force a create on both sides.
        this.postOffice.registerCallback(LiveShareCommands.historyCreate, this.onRemoteCreate, this).ignoreErrors();
        this.postOffice.registerCallback(LiveShareCommands.historyCreateSync, this.onRemoteSync, this).ignoreErrors();

        // Make a unique id so we can tell who sends a message
        this.id = uuid();
    }

    public getActive() : IHistory | undefined {
        return this.activeHistory;
    }

    public async getOrCreateActive() : Promise<IHistory> {
        if (!this.activeHistory) {
            this.activeHistory = this.create();
        }

        // Make sure all other providers have an active history.
        await this.synchronizeCreate();

        // Now that all of our peers have sync'd, return the history to use.
        return this.activeHistory;
    }

    public dispose() : Promise<void> {
        return this.postOffice.dispose();
    }

    private create = () => {
        const result = this.serviceContainer.get<IHistory>(IHistory);
        const handler = result.closed(this.onHistoryClosed);
        this.disposables.push(result);
        this.disposables.push(handler);
        return result;
    }

    private onPeerCountChanged(newCount: number) {
        // If we're losing peers, resolve all syncs
        if (newCount < this.postOffice.peerCount) {
            Object.keys(this.pendingSyncs).forEach(k => this.pendingSyncs[k].waitable.resolve());
            this.pendingSyncs = {};
        }
    }

    private onRemoteCreate(...args: any[]) {
        // Should be a single arg, the originator of the create
        if (args.length > 0 && args[0].toString() !== this.id) {
            // The other side is creating a history window. Create on this side. We don't need to show
            // it as the running of new code should do that.
            if (!this.activeHistory) {
                this.activeHistory = this.create();
            }

            // Tell the requestor that we got its message (it should be waiting for all peers to sync)
            this.postOffice.postCommand(LiveShareCommands.historyCreateSync, ...args);
        }
    }

    private onRemoteSync(...args: any[]) {
        // Should be a single arg, the originator of the create
        if (args.length > 1 && args[0].toString() === this.id) {
            // Update our pending wait count on the matching pending sync
            const key = args[1].toString();
            if (this.pendingSyncs.hasOwnProperty(key)) {
                this.pendingSyncs[key].count -= 1;
                if (this.pendingSyncs[key].count <= 0) {
                    this.pendingSyncs[key].waitable.resolve();
                }
            }
        }
    }

    private onHistoryClosed = (history: IHistory) => {
        if (this.activeHistory === history) {
            this.activeHistory = undefined;
        }
    }

    private synchronizeCreate() : Promise<void> {
        // Create a new pending wait if necessary
        if (this.postOffice.peerCount > 0) {
            const key = uuid();
            const waitable = createDeferred<void>();
            this.pendingSyncs[key] = { count: this.postOffice.peerCount, waitable };

            // Make sure all providers have an active history
            this.postOffice.postCommand(LiveShareCommands.historyCreate, this.id, key);

            // Wait for the waitable to be signaled or the peer count on the post office to change
            return waitable.promise;
        }

        return Promise.resolve();
    }

}
