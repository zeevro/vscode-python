// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

// tslint:disable:no-default-export no-invalid-this
export default function (source: string) {
    if (source.indexOf('require(path.join') > 0) {
        source = source.replace(/require\(path.join\(__dirname,\s'(.*)'\)\)/g, 'require(\'./$1\')');
    }
    return source;
}
