// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Raw imports (e.g. `import x from './f.md?raw'`) return the file text.
declare module '*?raw' {
  const content: string;
  export default content;
}
