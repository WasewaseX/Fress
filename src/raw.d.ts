// Raw imports (e.g. `import x from './f.md?raw'`) return the file text.
declare module '*?raw' {
  const content: string;
  export default content;
}
