// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// tslint:disable:no-default-export no-invalid-this
function default_1(source) {
    if (source.indexOf('require(path.join') > 0) {
        source = source.replace(/require\(path.join\(__dirname,\s'(.*)'\)\)/g, 'require(\'./$1\')');
    }
    return source;
}
exports.default = default_1;
