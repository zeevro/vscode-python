// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { injectable } from 'inversify';
import * as vsls from 'vsls/vscode';
import * as uuid from 'uuid/v4';
import * as path from 'path';
import { Event, Uri, Disposable, TreeDataProvider, EventEmitter, CancellationToken } from 'vscode';

import { ILiveShareTestingApi } from '../../client/common/application/types';
import { EXTENSION_ROOT_DIR } from '../../client/constants';
import { noop } from '../../client/common/utils/misc';

// tslint:disable:no-any unified-signatures

class MockLiveService implements vsls.SharedService, vsls.SharedServiceProxy {
    public isServiceAvailable: boolean = true;
    private changeIsServiceAvailableEmitter: EventEmitter<boolean> = new EventEmitter<boolean>();
    private requestHandlers : Map<string, vsls.RequestHandler> = new Map<string, vsls.RequestHandler>();
    private notifyHandlers : Map<string, vsls.NotifyHandler> = new Map<string, vsls.NotifyHandler>();

    constructor(private name: string) {
    }

    public get onDidChangeIsServiceAvailable(): Event<boolean> {
        return this.changeIsServiceAvailableEmitter.event;
    }
    public request(name: string, args: any[], cancellation?: CancellationToken): Promise<any> {
        // See if any handlers. 
        const handler = this.requestHandlers.get(name); 
        if (handler) {
            return handler(args, cancellation);
        }
    }
    public onRequest(name: string, handler: vsls.RequestHandler): void {
        this.requestHandlers.set(name, handler);
    }
    public onNotify(name: string, handler: vsls.NotifyHandler): void {
        this.notifyHandlers.set(name, handler);
    }
    public notify(name: string, args: object): void {
        // See if any handlers. 
        const handler = this.notifyHandlers.get(name);
        if (handler) {
            handler(args);
        }
    }
}

type ArgumentType = 'boolean' | 'number' | 'string' | 'object' | 'function' | 'array' | 'uri';

function checkArg(value: any, name: string, type?: ArgumentType) {
    if (!value) {
        throw new Error('Argument \'' + name + '\' is required.');
    } else if (type) {
        if (type === 'array') {
            if (!Array.isArray(value)) {
                throw new Error('Argument \'' + name + '\' must be an array.');
            }
        } else if (type === 'uri') {
            if (!(value instanceof Uri)) {
                throw new Error('Argument \'' + name + '\' must be a Uri object.');
            }
        } else if (type === 'object' && Array.isArray(value)) {
            throw new Error('Argument \'' + name + '\' must be a a non-array object.');
        } else if (typeof value !== type) {
            throw new Error('Argument \'' + name + '\' must be type \'' + type + '\'.');
        }
    }
}


class MockLiveShare implements vsls.LiveShare, vsls.Session, vsls.Peer {
    private static others : MockLiveShare [] = [];
    private static services : Map<string, MockLiveService> = new Map<string, MockLiveService>();
    private changeSessionEmitter = new EventEmitter<vsls.SessionChangeEvent>();
    private changePeersEmitter = new EventEmitter<vsls.PeersChangeEvent>();
    private currentPeers : vsls.Peer[] = [];
    private _id = uuid();
    private _peerNumber = 0;
    constructor(private _role: vsls.Role) {
        this._peerNumber = _role === vsls.Role.Host ? 0 : 1;
        MockLiveShare.others.push(this);
        MockLiveShare.others.forEach(f => f.onPeerConnected(this));
    }

    public onPeerConnected(peer: MockLiveShare) {
        if (peer.role != this.role) {
            this.currentPeers.push(peer);
            this.changePeersEmitter.fire({added: [peer], removed: []});
        }
    }

    public get session() : vsls.Session {
        return this;
    }

    public start() : Promise<void> {
        this.changeSessionEmitter.fire({session: this});
        return Promise.resolve();
    }
    public get role(): vsls.Role {
        return this._role;
    }
    public get id(): string {
        return this._id;
    }
    public get peerNumber(): number {
        return this._peerNumber;
    }
    public get user(): vsls.UserInfo {
        return {
            displayName: 'Test',
            emailAddress: 'Test@Microsoft.Com',
            userName: 'Test'
        };
    }
    public get access(): vsls.Access {
        return vsls.Access.None;
    }

    public get onDidChangeSession(): Event<vsls.SessionChangeEvent> {
        return this.changeSessionEmitter.event;
    }
    public get peers(): vsls.Peer[] {
        return this.currentPeers;
    }
    public get onDidChangePeers(): Event<vsls.PeersChangeEvent> {
        return this.changePeersEmitter.event;
    }
    public share(options?: vsls.ShareOptions): Promise<Uri> {
        throw new Error('Method not implemented.');
    }
    public join(link: Uri, options?: vsls.JoinOptions): Promise<void> {
        throw new Error('Method not implemented.');
    }
    public end(): Promise<void> {
        throw new Error('Method not implemented.');
    }
    public shareService(name: string): Promise<vsls.SharedService> {
        if (!MockLiveShare.services.has(name)) {
            MockLiveShare.services.set(name, new MockLiveService(name));
        }
        return Promise.resolve(MockLiveShare.services.get(name));
    }
    public unshareService(name: string): Promise<void> {
        MockLiveShare.services.delete(name);
        return Promise.resolve();
    }
    public getSharedService(name: string): Promise<vsls.SharedServiceProxy> {
        return Promise.resolve(MockLiveShare.services.get(name));
    }
    public convertLocalUriToShared(localUri: Uri): Uri {
        // Do the same checking that liveshare does
        checkArg(localUri, 'localUri', 'uri');

        if (this.session.role !== vsls.Role.Host) {
            throw new Error('Only the host role can convert shared URIs.');
        }

        const scheme = 'vsls';
        if (localUri.scheme === scheme) {
            throw new Error(`URI is already a ${scheme} URI: ${localUri}`);
        }

        if (localUri.scheme !== 'file') {
            throw new Error(`Not a workspace file URI: ${localUri}`);
        }

        const file = path.basename(localUri.fsPath);
        return Uri.parse(`vsls:${file}`);
    }
    public convertSharedUriToLocal(sharedUri: Uri): Uri {
        checkArg(sharedUri, 'sharedUri', 'uri');

        if (this.session.role !== vsls.Role.Host) {
            throw new Error('Only the host role can convert shared URIs.');
        }

        const scheme = 'vsls';
        if (sharedUri.scheme !== scheme) {
            throw new Error(
                `Not a shared URI: ${sharedUri}`);
        }

        // Extract the path and combine with root
        return Uri.file(path.join(EXTENSION_ROOT_DIR, sharedUri.fragment));
    }
    public registerCommand(command: string, isEnabled?: () => boolean, thisArg?: any): Disposable {
        throw new Error('Method not implemented.');
    }
    public registerTreeDataProvider<T>(viewId: vsls.View, treeDataProvider: TreeDataProvider<T>): Disposable {
        throw new Error('Method not implemented.');
    }
    public registerContactServiceProvider(name: string, contactServiceProvider: vsls.ContactServiceProvider): Disposable {
        throw new Error('Method not implemented.');
    }
    public shareServer(server: vsls.Server): Promise<Disposable> {
        // Ignore for now. We don't need to port forward during a test
        return Promise.resolve({ dispose: noop });
    }
}

@injectable()
export class MockLiveShareApi implements ILiveShareTestingApi {

    private currentRole: vsls.Role = vsls.Role.None;
    private currentApi : MockLiveShare | null = null;

    public getApi(): Promise<vsls.LiveShare | null> {
        return Promise.resolve(this.currentApi);
    }

    public forceRole(role: vsls.Role) {
        // Force a role on our live share api
        if (role !== this.currentRole) {
            this.currentApi = new MockLiveShare(role);
            this.currentRole = role;
        }
    }

    public startSession() {
        if (this.currentRole === vsls.Role.Host && this.currentApi) {
            this.currentApi.start();
        } else {
            throw Error('Cannot start session unless host.');
        }
    }
}
