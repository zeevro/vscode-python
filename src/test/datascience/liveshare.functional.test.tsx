// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import * as assert from 'assert';
import { mount, ReactWrapper } from 'enzyme';
import * as path from 'path';
import * as React from 'react';
import { SemVer } from 'semver';
import * as TypeMoq from 'typemoq';
import { Disposable } from 'vscode';
import * as vsls from 'vsls/vscode';

import {
    ILiveShareApi,
    ILiveShareTestingApi,
    IWebPanel,
    IWebPanelMessageListener,
    IWebPanelProvider,
    WebPanelMessage
} from '../../client/common/application/types';
import { createDeferred, Deferred } from '../../client/common/utils/async';
import { Architecture } from '../../client/common/utils/platform';
import { HistoryMessageListener } from '../../client/datascience/historyMessageListener';
import { HistoryMessages } from '../../client/datascience/historyTypes';
import { IHistory, IHistoryProvider } from '../../client/datascience/types';
import { InterpreterType, PythonInterpreter } from '../../client/interpreter/contracts';
import { MainPanel } from '../../datascience-ui/history-react/MainPanel';
import { IVsCodeApi } from '../../datascience-ui/react-common/postOffice';
import { DataScienceIocContainer } from './dataScienceIocContainer';
import { addCode, addMockData, verifyHtmlOnCell, CellPosition } from './historyTestHelpers';
import { SupportedCommands } from './mockJupyterManager';
import { blurWindow, createMessageEvent, waitForUpdate } from './reactHelpers';
import { Container } from 'inversify';

//tslint:disable:trailing-comma no-any no-multiline-string

class ContainerData {
    public ioc: DataScienceIocContainer | undefined;
    public webPanelListener: IWebPanelMessageListener | undefined;
    public wrapper: ReactWrapper<any, Readonly<{}>, React.Component> | undefined;
    public wrapperCreatedPromise : Deferred<boolean> = createDeferred<boolean>();
    public postMessage: ((ev: MessageEvent) => void) | undefined;

    public dispose() {
        if (this.wrapper) {
            // Blur window focus so we don't have editors polling
            blurWindow();
            this.wrapper.unmount();
            this.wrapper = undefined;
        }
    }
}

// tslint:disable-next-line:max-func-body-length no-any
suite('LiveShare tests', () => {
    const disposables: Disposable[] = [];
    let hostContainer: ContainerData;
    let guestContainer: ContainerData;

    const workingPython: PythonInterpreter = {
        path: '/foo/bar/python.exe',
        version: new SemVer('3.6.6-final'),
        sysVersion: '1.0.0.0',
        sysPrefix: 'Python',
        type: InterpreterType.Unknown,
        architecture: Architecture.x64,
    };

    setup(() => {
        hostContainer = createContainer(vsls.Role.Host);
        guestContainer = createContainer(vsls.Role.Guest);
    });

    teardown(async () => {
        for (let i = 0; i < disposables.length; i += 1) {
            const disposable = disposables[i];
            if (disposable) {
                // tslint:disable-next-line:no-any
                const promise = disposable.dispose() as Promise<any>;
                if (promise) {
                    await promise;
                }
            }
        }
        await hostContainer.dispose();
        await guestContainer.dispose();
    });

    function createContainer(role: vsls.Role) : ContainerData {
        const result = new ContainerData();
        result.ioc = new DataScienceIocContainer();
        result.ioc.registerDataScienceTypes();

        if (result.ioc.mockJupyter) {
            result.ioc.mockJupyter.addInterpreter(workingPython, SupportedCommands.all);
        }

        // Force the container to mock actual live share
        const liveShareTest = result.ioc.get<ILiveShareApi>(ILiveShareApi) as ILiveShareTestingApi;
        liveShareTest.forceRole(role);

        const webPanelProvider = TypeMoq.Mock.ofType<IWebPanelProvider>();
        const webPanel = TypeMoq.Mock.ofType<IWebPanel>();

        result.ioc.serviceManager.addSingletonInstance<IWebPanelProvider>(IWebPanelProvider, webPanelProvider.object);

        // Setup the webpanel provider so that it returns our dummy web panel. It will have to talk to our global JSDOM window so that the react components can link into it
        webPanelProvider.setup(p => p.create(TypeMoq.It.isAny(), TypeMoq.It.isAnyString(), TypeMoq.It.isAnyString(), TypeMoq.It.isAnyString(), TypeMoq.It.isAny())).returns((listener: IWebPanelMessageListener, title: string, script: string, css: string) => {
            // Keep track of the current listener. It listens to messages through the vscode api
            result.webPanelListener = listener;

            // Return our dummy web panel
            return webPanel.object;
        });
        webPanel.setup(p => p.postMessage(TypeMoq.It.isAny())).callback((m: WebPanelMessage) => {
            const message = createMessageEvent(m);
            result.postMessage(message);
        }); 
        webPanel.setup(p => p.show());

        // We need to mount the react control before we even create a history object. Otherwise the mount will miss rendering some parts
        mountReactControl(result);

        // Make sure the history provider in the container is created (the extension does this on startup in the extension)
        result.ioc.get<IHistoryProvider>(IHistoryProvider);

        return result;
    }

    function mountReactControl(container: ContainerData) {
        // Setup the acquireVsCodeApi. The react control will cache this value when it's mounted.
        const globalAcquireVsCodeApi = (): IVsCodeApi => {
            return {
                // tslint:disable-next-line:no-any
                postMessage: (msg: any) => {
                    if (container.webPanelListener) {
                        container.webPanelListener.onMessage(msg.type, msg.payload);
                    }
                },
                // tslint:disable-next-line:no-any no-empty
                setState: (msg: any) => {

                },
                // tslint:disable-next-line:no-any no-empty
                getState: () => {
                    return {};
                }
            };
        };
        // tslint:disable-next-line:no-string-literal
        (global as any)['acquireVsCodeApi'] = globalAcquireVsCodeApi;

        // Remap event handlers to point to the container.
        const oldListener = window.addEventListener;
        window.addEventListener = (event, cb) => {
            if (event === 'message') {
                container.postMessage = cb;
            }
        };
        
        // Mount our main panel. This will make the global api be cached and have the event handler registered
        const mounted = mount(<MainPanel baseTheme='vscode-light' codeTheme='light_vs' testMode={true} skipDefault={true} />);
        container.wrapper = mounted;

        // We can remove the global api and event listener now.
        delete (global as any)['ascquireVsCodeApi'];
        window.addEventListener = oldListener;
    }

    async function getOrCreateHistory(role: vsls.Role) : Promise<IHistory> {
        // Get the container to use based on the role. 
        const container = role === vsls.Role.Host ? hostContainer : guestContainer;
        const history = await container.ioc!.get<IHistoryProvider>(IHistoryProvider).getOrCreateActive();

        // During testing the MainPanel sends the init message before our history is created.
        // Pretend like it's happening now
        const listener = ((history as any)['messageListener']) as HistoryMessageListener;
        listener.onMessage(HistoryMessages.Started, {});

        return history;
    }

    function isSessionStarted(role: vsls.Role) : boolean {
        const container = role === vsls.Role.Host? hostContainer : guestContainer;
        const api = container.ioc.get<ILiveShareApi>(ILiveShareApi) as ILiveShareTestingApi;
        return api.isSessionStarted;
    }

    async function addCodeToRole(role: vsls.Role, code: string, expectedRenderCount: number = 5) : Promise<ReactWrapper<any, Readonly<{}>, React.Component>> {
        const container = role === vsls.Role.Host? hostContainer : guestContainer;

        // If just the host session has started or nobody, just do a normal add code. 
        const guestStarted = isSessionStarted(vsls.Role.Guest);
        if (!guestStarted) {
            await addCode(() => getOrCreateHistory(role), container.wrapper, code, expectedRenderCount);
        } else {
            // Otherwise more complicated. We have to wait for renders on both

            // Get a render promise with the expected number of renders for both wrappers
            const hostRenderPromise = waitForUpdate(hostContainer.wrapper, MainPanel, expectedRenderCount);
            const guestRenderPromise = waitForUpdate(guestContainer.wrapper, MainPanel, expectedRenderCount);

            // Add code to the apropriate container
            const host = await getOrCreateHistory(vsls.Role.Host);
            const guest = await getOrCreateHistory(vsls.Role.Guest);
            await (role === vsls.Role.Host ? host.addCode(code, 'foo.py', 2) : guest.addCode(code, 'foo.py', 2));

            // Wait for all of the renders to go through
            await Promise.all([hostRenderPromise, guestRenderPromise]);
        }
        return container.wrapper;
    }

    function startSession(role: vsls.Role) : Promise<void> {
        const container = role === vsls.Role.Host? hostContainer : guestContainer;
        const api = container.ioc.get<ILiveShareApi>(ILiveShareApi) as ILiveShareTestingApi;
        return api.startSession();
    }

    // Tests to write
    // - Host by itself, addcode, see that it shows up
    // - Host and Guest
    //      -- Add code host, see it on guest and vice versa
    // - Host and Guest
    //      -- Add code guest, close host history. 


    test('Host alone', async () => {
        // Should only need mock data in host
        addMockData(hostContainer.ioc, 'a=1\na', 1);

        // Start the host session first
        startSession(vsls.Role.Host);

        // Just run some code in the host 
        const wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);
    });

    test('Host & Guest Simple', async () => {
        // Should only need mock data in host
        addMockData(hostContainer.ioc, 'a=1\na', 1);

        // Create the host history and then the guest history
        const host = await getOrCreateHistory(vsls.Role.Host);
        await startSession(vsls.Role.Host);
        const guest = await getOrCreateHistory(vsls.Role.Guest);
        await startSession(vsls.Role.Guest);

        // Send code through the host
        const wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);

        // Verify it ended up on the guest too
        assert.ok(guestContainer.wrapper, 'Guest wrapper not created');
        verifyHtmlOnCell(guestContainer.wrapper, '<span>1</span>', CellPosition.Last);
    });

    test('Host startup and guest restart', async () => {
        // Should only need mock data in host
        addMockData(hostContainer.ioc, 'a=1\na', 1);

        // Start the host, and add some data
        const host = await getOrCreateHistory(vsls.Role.Host);
        await startSession(vsls.Role.Host);

        // Send code through the host
        let wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);

        // Shutdown the host
        await host.dispose();

        // Startup a guest and run some code. 
        await startSession(vsls.Role.Guest);
        wrapper = await addCodeToRole(vsls.Role.Guest, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);

        assert.ok(hostContainer.wrapper, 'Host wrapper not created');
        verifyHtmlOnCell(hostContainer.wrapper, '<span>1</span>', CellPosition.Last);
    });

});
