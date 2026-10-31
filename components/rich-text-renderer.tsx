"use client"
import { useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { FontFamily } from '@tiptap/extension-font-family'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { Extension } from '@tiptap/core'
import type { JSONContent } from "@/types/resume"

interface RichTextRendererProps {
  content: JSONContent
  className?: string
}

// Custom extension for font size
const FontSize = Extension.create({
  name: 'fontSize',

  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.fontSize || null,
            renderHTML: (attributes: Record<string, unknown>) => {
              const fontSize = typeof attributes.fontSize === 'string' ? attributes.fontSize : null;
              if (!fontSize) {
                return {}
              }
              return {
                style: `font-size: ${fontSize}`,
              }
            },
          },
        },
      },
    ]
  },
})

// Default empty content
const getDefaultContent = (): JSONContent => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [],
    },
  ],
})

/** 段落没有任何可见字符时视为空段落（仅含换行或空白文本） */
function isEmptyParagraph(node: JSONContent): boolean {
  if (node.type !== 'paragraph') return false
  const children = node.content ?? []
  return children.every(
    (child) => child.type === 'hardBreak' || (child.type === 'text' && !(child.text ?? '').trim())
  )
}

/**
 * 去掉文档末尾的空段落。编辑时删除文字常会留下空段落，它们带有行高与段后距，
 * 在预览、打印与导出中会凭空占位，甚至把内容推到新的一页。编辑器中的原始内容不受影响。
 */
function trimTrailingEmptyParagraphs(doc: JSONContent): JSONContent {
  const content = doc.content ?? []
  let end = content.length
  while (end > 1 && isEmptyParagraph(content[end - 1])) end--
  return end === content.length ? doc : { ...doc, content: content.slice(0, end) }
}

/**
 * Read-only Tiptap renderer for preview
 */
export default function RichTextRenderer({
  content,
  className = ''
}: RichTextRendererProps) {

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        trailingNode: false,
      }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      Underline,
      Link.configure({
        openOnClick: true,
        HTMLAttributes: {
          class: 'text-blue-600 underline hover:text-blue-800',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
      TextAlign.configure({
        types: ['paragraph'],
      }),
    ],
    content: trimTrailingEmptyParagraphs(content || getDefaultContent()),
    editable: false,
    editorProps: {
      attributes: {
        class: className,
      },
    },
  })

  // Update content when it changes
  useEffect(() => {
    if (!editor) return

    const newContent = trimTrailingEmptyParagraphs(content || getDefaultContent())
    const currentContent = editor.getJSON()

    // Only update if content actually changed
    if (JSON.stringify(currentContent) !== JSON.stringify(newContent)) {
      editor.commands.setContent(newContent)
    }
  }, [content, editor])

  if (!editor) {
    return null
  }

  return <EditorContent editor={editor} />
}
