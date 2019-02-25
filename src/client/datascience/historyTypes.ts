// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import { ICell, IHistoryInfo } from './types';
import { file } from 'tmp';

export namespace HistoryMessages {
    export const StartCell = 'start_cell';
    export const FinishCell = 'finish_cell';
    export const UpdateCell = 'update_cell';
    export const GotoCodeCell = 'gotocell_code';
    export const RestartKernel = 'restart_kernel';
    export const Export = 'export_to_ipynb';
    export const GetAllCells = 'get_all_cells';
    export const ReturnAllCells = 'return_all_cells';
    export const DeleteCell = 'delete_cell';
    export const DeleteAllCells = 'delete_all_cells';
    export const Undo = 'undo';
    export const Redo = 'redo';
    export const ExpandAll = 'expand_all';
    export const CollapseAll = 'collapse_all';
    export const StartProgress = 'start_progress';
    export const StopProgress = 'stop_progress';
    export const Interrupt = 'interrupt';
    export const SubmitNewCell = 'submit_new_cell';
    export const UpdateSettings = 'update_settings';
    export const SendInfo = 'send_info';
    export const Started = 'started';
    export const AddedSysInfo = 'added_sys_info'
    export const RemoteAddCode = 'remote_add_code';
}

// These are the messages that will mirror'd to guest/hosts in
// a live share session
export const HistoryRemoteMessages : string[] = [
    HistoryMessages.SubmitNewCell,
    HistoryMessages.AddedSysInfo,
    HistoryMessages.RemoteAddCode
]

export interface IGotoCode {
    file: string,
    line: number
}

export interface IAddedSysInfo {
    id: string,
    sysInfoCell: ICell
}

export interface IRemoteAddCode extends IExecuteInfo {
    originator: string
}

export interface ISubmitNewCell {
    code: string,
    id: string
}

export interface IExecuteInfo {
    code: string,
    id: string,
    file: string,
    line: number
}

// Map all messages to specific payloads
export class IHistoryMapping {
    [HistoryMessages.StartCell]: ICell;
    [HistoryMessages.FinishCell]: ICell;
    [HistoryMessages.UpdateCell]: ICell;
    [HistoryMessages.GotoCodeCell]: IGotoCode;
    [HistoryMessages.RestartKernel]: never | undefined;
    [HistoryMessages.Export]: ICell[];
    [HistoryMessages.GetAllCells]: ICell;
    [HistoryMessages.ReturnAllCells]: ICell[];
    [HistoryMessages.DeleteCell]: never | undefined;
    [HistoryMessages.DeleteAllCells]: never | undefined;
    [HistoryMessages.Undo]: never | undefined;
    [HistoryMessages.Redo]: never | undefined;
    [HistoryMessages.ExpandAll]: never | undefined;
    [HistoryMessages.CollapseAll]: never | undefined;
    [HistoryMessages.StartProgress]: never | undefined;
    [HistoryMessages.StopProgress]: never | undefined;
    [HistoryMessages.Interrupt]: never | undefined;
    [HistoryMessages.UpdateSettings]: string;
    [HistoryMessages.SubmitNewCell]: ISubmitNewCell;
    [HistoryMessages.SendInfo]: IHistoryInfo;
    [HistoryMessages.Started]: never | undefined;
    [HistoryMessages.AddedSysInfo]: IAddedSysInfo;
    [HistoryMessages.RemoteAddCode]: IRemoteAddCode;
}
