import { useEffect } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import {
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Paperclip,
  Redo2,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";
import { IconButton } from "./Controls";
import { KEYBOARD_SHORTCUTS } from "../shortcuts";

interface UseMailEditorOptions {
  initialHtml?: string;
  autoFocus?: boolean;
  onChange(value: { html: string; text: string }): void;
  onModEnter?(): void;
}

export function useMailEditor({
  initialHtml = "<p></p>",
  autoFocus = false,
  onChange,
  onModEnter,
}: UseMailEditorOptions): Editor | null {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["https", "mailto"],
      }),
    ],
    content: editorHtmlFromEmail(initialHtml),
    immediatelyRender: false,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        spellcheck: "true",
        autocapitalize: "sentences",
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return false;
        if (!onModEnter) return false;
        event.preventDefault();
        event.stopPropagation();
        onModEnter();
        return true;
      },
    },
    onUpdate({ editor: instance }) {
      onChange({
        html: emailHtmlFromEditor(instance.getHTML()),
        text: instance.getText({ blockSeparator: "\n" }),
      });
    },
  });

  useEffect(() => {
    if (!autoFocus || !editor) return;
    const frame = window.requestAnimationFrame(() => editor.commands.focus("end"));
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, editor]);

  return editor;
}

/**
 * The editor starts a new paragraph on every Enter and writes a blank line as an empty paragraph.
 * Mail clients give paragraphs default margins and collapse empty ones, so every line would arrive
 * spaced apart and the blank lines would vanish. Zero margins and a break in each empty paragraph
 * make the message look the way it did in the editor.
 */
export function emailHtmlFromEditor(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const paragraph of document.body.querySelectorAll("p")) {
    paragraph.style.margin = "0";
    if (!paragraph.hasChildNodes()) paragraph.append(document.createElement("br"));
  }
  return document.body.innerHTML;
}

/** Turns the blank lines {@link emailHtmlFromEditor} wrote back into empty editor paragraphs. */
function editorHtmlFromEmail(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const paragraph of document.body.querySelectorAll("p")) {
    if (paragraph.childNodes.length === 1 && paragraph.firstChild?.nodeName === "BR")
      paragraph.firstChild.remove();
  }
  return document.body.innerHTML;
}

export function MailEditorContent({
  editor,
  empty,
  placeholder,
  className = "",
  onFocus,
}: {
  editor: Editor | null;
  empty: boolean;
  placeholder?: string;
  className?: string;
  onFocus?(): void;
}) {
  const emptyList = Boolean(
    empty && (editor?.isActive("bulletList") || editor?.isActive("orderedList")),
  );

  return (
    <div
      className={`mail-editor ${className}`}
      onFocusCapture={onFocus}
      onMouseDown={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest(".tiptap")) return;
        event.preventDefault();
        editor?.commands.focus();
      }}
    >
      {empty && placeholder && !emptyList ? (
        <span className="mail-editor-placeholder">{placeholder}</span>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}

export function MailEditorToolbar({
  editor,
  onAttach,
}: {
  editor: Editor | null;
  onAttach?(): void;
}) {
  return (
    <div className="format-buttons" aria-label="Formatting">
      <IconButton
        label="Bold"
        className={editor?.isActive("bold") ? "active" : ""}
        tooltipSide="top"
        shortcut={KEYBOARD_SHORTCUTS.bold}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <Bold size={16} />
      </IconButton>
      <IconButton
        label="Italic"
        className={editor?.isActive("italic") ? "active" : ""}
        tooltipSide="top"
        shortcut={KEYBOARD_SHORTCUTS.italic}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <Italic size={16} />
      </IconButton>
      <IconButton
        label="Underline"
        className={editor?.isActive("underline") ? "active" : ""}
        tooltipSide="top"
        shortcut={KEYBOARD_SHORTCUTS.underline}
        onClick={() => editor?.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon size={16} />
      </IconButton>
      <span className="format-separator" />
      <IconButton
        label="Bulleted list"
        className={editor?.isActive("bulletList") ? "active" : ""}
        tooltipSide="top"
        shortcut={KEYBOARD_SHORTCUTS.bulletedList}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List size={16} />
      </IconButton>
      <IconButton
        label="Numbered list"
        className={editor?.isActive("orderedList") ? "active" : ""}
        tooltipSide="top"
        shortcut={KEYBOARD_SHORTCUTS.numberedList}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={16} />
      </IconButton>
      <span className="format-separator" />
      <IconButton
        label={editor?.isActive("link") ? "Remove link" : "Add link"}
        className={editor?.isActive("link") ? "active" : ""}
        tooltipSide="top"
        onClick={() => {
          if (editor?.isActive("link")) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          const href = window.prompt("Link address");
          if (href) editor?.chain().focus().setLink({ href }).run();
        }}
      >
        <LinkIcon size={16} />
      </IconButton>
      {onAttach ? (
        <IconButton label="Attach files" tooltipSide="top" onClick={onAttach}>
          <Paperclip size={16} />
        </IconButton>
      ) : null}
      <span className="format-separator" />
      <IconButton
        label="Undo"
        tooltipSide="top"
        shortcut={KEYBOARD_SHORTCUTS.undo}
        disabled={!editor?.can().chain().focus().undo().run()}
        onClick={() => editor?.chain().focus().undo().run()}
      >
        <Undo2 size={16} />
      </IconButton>
      <IconButton
        label="Redo"
        tooltipSide="top"
        shortcut={KEYBOARD_SHORTCUTS.redo}
        disabled={!editor?.can().chain().focus().redo().run()}
        onClick={() => editor?.chain().focus().redo().run()}
      >
        <Redo2 size={16} />
      </IconButton>
    </div>
  );
}
