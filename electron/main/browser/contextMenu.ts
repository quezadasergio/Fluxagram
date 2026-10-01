import { Menu, clipboard, shell, type WebContents } from 'electron'

/**
 * Chromium-like context menu for column/login WebContents.
 * Supports copy image, paste into Instagram compose, links, and edit actions.
 */
export function attachContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, params) => {
    const { editFlags } = params
    const items: Electron.MenuItemConstructorOptions[] = []

    const pushSep = (): void => {
      if (items.length > 0 && items[items.length - 1].type !== 'separator') {
        items.push({ type: 'separator' })
      }
    }

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions ?? []) {
        items.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion)
        })
      }
      if ((params.dictionarySuggestions ?? []).length > 0) {
        pushSep()
      }
      items.push({
        label: 'Añadir al diccionario',
        click: () => {
          webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        }
      })
      pushSep()
    }

    if (params.isEditable) {
      items.push(
        {
          label: 'Deshacer',
          accelerator: 'CommandOrControl+Z',
          enabled: editFlags.canUndo,
          click: () => webContents.undo()
        },
        {
          label: 'Rehacer',
          accelerator: 'Shift+CommandOrControl+Z',
          enabled: editFlags.canRedo,
          click: () => webContents.redo()
        },
        { type: 'separator' },
        {
          label: 'Cortar',
          accelerator: 'CommandOrControl+X',
          enabled: editFlags.canCut,
          click: () => webContents.cut()
        },
        {
          label: 'Copiar',
          accelerator: 'CommandOrControl+C',
          enabled: editFlags.canCopy,
          click: () => webContents.copy()
        },
        {
          label: 'Pegar',
          accelerator: 'CommandOrControl+V',
          enabled: editFlags.canPaste,
          click: () => webContents.paste()
        },
        {
          label: 'Pegar sin formato',
          accelerator: 'Shift+CommandOrControl+V',
          enabled: editFlags.canPaste,
          click: () => webContents.pasteAndMatchStyle()
        },
        {
          label: 'Seleccionar todo',
          accelerator: 'CommandOrControl+A',
          enabled: editFlags.canSelectAll,
          click: () => webContents.selectAll()
        }
      )
    } else if (params.selectionText && params.selectionText.trim().length > 0) {
      items.push({
        label: 'Copiar',
        accelerator: 'CommandOrControl+C',
        click: () => webContents.copy()
      })
    }

    const isImage = params.mediaType === 'image' || params.hasImageContents
    if (isImage) {
      pushSep()
      items.push({
        label: 'Copiar imagen',
        click: () => webContents.copyImageAt(params.x, params.y)
      })
      if (params.srcURL) {
        items.push(
          {
            label: 'Copiar dirección de la imagen',
            click: () => clipboard.writeText(params.srcURL)
          },
          {
            label: 'Guardar imagen como…',
            click: () => webContents.downloadURL(params.srcURL)
          },
          {
            label: 'Abrir imagen en el navegador',
            click: () => {
              void shell.openExternal(params.srcURL)
            }
          }
        )
      }
    }

    if (params.mediaType === 'video' || params.mediaType === 'audio') {
      pushSep()
      if (params.srcURL) {
        items.push(
          {
            label: 'Copiar dirección del medio',
            click: () => clipboard.writeText(params.srcURL)
          },
          {
            label: 'Abrir medio en el navegador',
            click: () => {
              void shell.openExternal(params.srcURL)
            }
          }
        )
      }
    }

    if (params.linkURL) {
      pushSep()
      items.push(
        {
          label: 'Abrir enlace en el navegador',
          click: () => {
            void shell.openExternal(params.linkURL)
          }
        },
        {
          label: 'Copiar dirección del enlace',
          click: () => clipboard.writeText(params.linkURL)
        }
      )
    }

    if (items.length === 0 || (!params.isEditable && !params.selectionText && !isImage && !params.linkURL)) {
      pushSep()
      items.push(
        {
          label: 'Atrás',
          enabled: webContents.navigationHistory.canGoBack(),
          click: () => webContents.navigationHistory.goBack()
        },
        {
          label: 'Adelante',
          enabled: webContents.navigationHistory.canGoForward(),
          click: () => webContents.navigationHistory.goForward()
        },
        {
          label: 'Recargar',
          click: () => webContents.reload()
        }
      )
    }

    while (items.length > 0 && items[items.length - 1].type === 'separator') {
      items.pop()
    }

    if (items.length === 0) return

    Menu.buildFromTemplate(items).popup()
  })
}
