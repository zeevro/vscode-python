// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import * as assert from 'assert';
import { mount, ReactWrapper } from 'enzyme';
import * as vsls from 'vsls/vscode';
import * as fs from 'fs-extra';
import { min } from 'lodash';
import * as path from 'path';
import * as React from 'react';
import { SemVer } from 'semver';
import * as TypeMoq from 'typemoq';
import { CancellationToken, Disposable, TextDocument, TextEditor } from 'vscode';

import {
    IApplicationShell,
    IDocumentManager,
    IWebPanel,
    IWebPanelMessageListener,
    IWebPanelProvider,
    WebPanelMessage,
    ILiveShareApi,
    ILiveShareTestingApi
} from '../../client/common/application/types';
import { EXTENSION_ROOT_DIR } from '../../client/common/constants';
import { IDataScienceSettings } from '../../client/common/types';
import { createDeferred, Deferred } from '../../client/common/utils/async';
import { noop } from '../../client/common/utils/misc';
import { Architecture } from '../../client/common/utils/platform';
import { EditorContexts } from '../../client/datascience/constants';
import { HistoryMessageListener } from '../../client/datascience/historyMessageListener';
import { HistoryMessages } from '../../client/datascience/historyTypes';
import { IHistory, IHistoryProvider, IJupyterExecution } from '../../client/datascience/types';
import { InterpreterType, PythonInterpreter } from '../../client/interpreter/contracts';
import { CellButton } from '../../datascience-ui/history-react/cellButton';
import { MainPanel } from '../../datascience-ui/history-react/MainPanel';
import { IVsCodeApi } from '../../datascience-ui/react-common/postOffice';
import { updateSettings } from '../../datascience-ui/react-common/settingsReactSide';
import { sleep } from '../core';
import { DataScienceIocContainer } from './dataScienceIocContainer';
import { SupportedCommands } from './mockJupyterManager';
import { blurWindow, createInputEvent, createKeyboardEvent, waitForUpdate } from './reactHelpers';
import { addCode, verifyHtmlOnCell } from './historyTestHelpers';

//tslint:disable:trailing-comma no-any no-multiline-string
enum CellInputState {
    Hidden,
    Visible,
    Collapsed,
    Expanded
}

enum CellPosition {
    First = 'first',
    Last = 'last'
}

class ContainerData {
    public ioc: DataScienceIocContainer | undefined;
    public webPanelListener: IWebPanelMessageListener | undefined;
    public wrapper: ReactWrapper<any, Readonly<{}>, React.Component> | undefined;
    public postMessage: ((m: WebPanelMessage) => void) | undefined;

    public dispose() {
        if (this.wrapper) {
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
        await hostContainer.ioc.dispose();
        await guestContainer.ioc.dispose();
    });

    function createContainer(role: vsls.Role) : ContainerData {
        const result = new ContainerData();
        result.ioc = new DataScienceIocContainer();
        result.ioc.registerDataScienceTypes();

        if (result.ioc.mockJupyter) {
            result.ioc.mockJupyter.addInterpreter(workingPython, SupportedCommands.all);
        }

        // Force the container to mock actual live share
        const liveShareTest = result.ioc.get<ILiveShareApi>('ILiveShareApi') as ILiveShareTestingApi;
        liveShareTest.forceRole(role);

        const webPanelProvider = TypeMoq.Mock.ofType<IWebPanelProvider>();
        const webPanel = TypeMoq.Mock.ofType<IWebPanel>();

        result.ioc.serviceManager.addSingletonInstance<IWebPanelProvider>(IWebPanelProvider, webPanelProvider.object);

        // Setup the webpanel provider so that it returns our dummy web panel. It will have to talk to our global JSDOM window so that the react components can link into it
        webPanelProvider.setup(p => p.create(TypeMoq.It.isAny(), TypeMoq.It.isAnyString(), TypeMoq.It.isAnyString(), TypeMoq.It.isAnyString(), TypeMoq.It.isAny())).returns((listener: IWebPanelMessageListener, title: string, script: string, css: string) => {
            // Keep track of the current listener. It listens to messages through the vscode api
            result.webPanelListener = listener;

            // At this point is also where we need to mount the web panel ui so that the history
            // object created can talk to it.
            mountReactControl(result);

            // Return our dummy web panel
            return webPanel.object;
        });
        webPanel.setup(p => p.postMessage(TypeMoq.It.isAny())).callback((m: WebPanelMessage) => {
            result.postMessage(m);
        }); 
        webPanel.setup(p => p.show());

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
        return container.ioc!.get<IHistoryProvider>('IHistoryProvider').getOrCreateActive();
    }

    async function addCodeToRole(role: vsls.Role, code: string, expectedRenderCount: number = 5) : Promise<ReactWrapper<any, Readonly<{}>, React.Component>> {
        const container = role === vsls.Role.Host? hostContainer : guestContainer;
        await addCode(await getOrCreateHistory(role), container.wrapper, code, expectedRenderCount);
        return container.wrapper;
    }

    // Tests to write
    // - Host by itself, addcode, see that it shows up
    // - Host and Guest
    //      -- Add code host, see it on guest and vice versa
    // - Host and Guest
    //      -- Add code guest, close host history. 


    test('Host alone', async () => {
        // Just run some code in the host 
        const wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);
    });

    test('Host & Guest Simple', async () => {
        // Create the host history and then the guest history
        const host = await getOrCreateHistory(vsls.Role.Host);
        const guest = await getOrCreateHistory(vsls.Role.Guest);

        // Send code through the host
        const wrapper = await addCodeToRole(vsls.Role.Host, 'a=1\na');
        verifyHtmlOnCell(wrapper, '<span>1</span>', CellPosition.Last);

        // Verify it ended up on the guest too
        assert.ok(guestContainer.wrapper, 'Guest wrapper not created');
        verifyHtmlOnCell(guestContainer.wrapper, '<span>1</span>', CellPosition.Last);
    });

});
