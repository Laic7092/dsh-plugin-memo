/**
 * Shared shapes.
 *
 * The indexer, the tree-sitter analyzer, the CLI and the panel all talk about
 * the same few things — a symbol, a file's entry, a whole index, the live plugin
 * state. They live here once so those modules cannot drift into three private
 * ideas of what an index is.
 *
 * @module dsh-plugin-memo/types
 */
export {};
