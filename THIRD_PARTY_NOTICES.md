# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below, distributed under
the MIT License, whose notice is reproduced in full as that license asks.

## pysolarcloud

<https://github.com/bugjam/pysolarcloud>, a Python package for the iSolarCloud
OpenAPI of Sungrow (PyPI package `pysolarcloud`). MIT License (`LICENSE.txt`
of the repository, version 0.5.0 of 2026-09-19, commit `9e45e63`, read on
2026-10-20).

Ported in `src/constants.js`, `src/oauth.js`, `src/api.js` and `src/model.js`:
the iSolarCloud gateways, sign-in pages and cloud ids of each server, the
layout of the authorization address (the state before the fragment), the
token and refresh endpoints and their bodies, the request headers and body
(`x-access-key`, Bearer token, `appkey`, `lang`), the paths of the plant list
and of the real-time data, the measure point ids and their meaning, and the
reading of the answers (`pageList`, `device_point_list`, `point_dict`). The
grid control part of pysolarcloud (`control.py`) is not used: this
integration is read only.

```
Copyright 2025 Tore Green

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
