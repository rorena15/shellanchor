# Third-Party Notices

ShellAnchor is licensed under the GNU General Public License v3.0 (see `LICENSE`).
It includes or depends on the following third-party software.

## Bundled in this repository (`static/vendor/`)

| Component | Version | License | Files |
| --- | --- | --- | --- |
| [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`) | 5.5.0 | MIT | `xterm.js`, `xterm.css` |
| `@xterm/addon-fit` | 0.10.0 | MIT | `addon-fit.js` |
| `@xterm/addon-web-links` | 0.11.0 | MIT | `addon-web-links.js` |

### xterm.js — MIT License

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The addons carry the same MIT license text with the notices
`Copyright (c) 2019, The xterm.js authors` (addon-fit) and
`Copyright (c) 2017, The xterm.js authors` (addon-web-links).

## Python runtime dependencies (installed with pip, not bundled)

| Package | License |
| --- | --- |
| [paramiko](https://www.paramiko.org/) | LGPL-2.1 |
| [websockets](https://github.com/python-websockets/websockets) | BSD-3-Clause |
| [cryptography](https://github.com/pyca/cryptography) | Apache-2.0 OR BSD-3-Clause |
| [pywinpty](https://github.com/andfoy/pywinpty) (Windows only) | MIT |

## Trademarks

MobaXterm is a trademark of Mobatek. ShellAnchor is an independent project and
is not affiliated with, endorsed by, or sponsored by Mobatek. The name is used
only to identify the session file format that ShellAnchor can import.
