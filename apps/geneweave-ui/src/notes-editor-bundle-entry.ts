// notes-editor-bundle-entry.ts
// Bundled separately by esbuild into dist/ui/notes-editor.bundle.js.
// Exports everything the dynamic import in notes-editor.ts expects.

export { Editor } from '@tiptap/core';
export { default as StarterKit } from '@tiptap/starter-kit';
export { Placeholder } from '@tiptap/extension-placeholder';
export { BubbleMenu as BubbleMenuExtension } from '@tiptap/extension-bubble-menu';
export { FloatingMenu as FloatingMenuExtension } from '@tiptap/extension-floating-menu';
export { TaskList } from '@tiptap/extension-task-list';
export { TaskItem } from '@tiptap/extension-task-item';
export { Link } from '@tiptap/extension-link';
export { Underline } from '@tiptap/extension-underline';
