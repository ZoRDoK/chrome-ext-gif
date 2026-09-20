# Сторонние компоненты

## gifenc 1.0.3 (vendored, попадает в поставку)

Файл `vendor/gifenc.js` — сборка `dist/gifenc.esm.js` из пакета npm `gifenc@1.0.3`,
автор Matt DesLauriers, лицензия MIT. Из сборки удалена только строка
`//# sourceMappingURL=gifenc.esm.js.map` (в поставку не входит source map);
остальной байт-в-байт код не менялся.

- Источник: https://github.com/mattdesl/gifenc (npm `gifenc@1.0.3`)
- SHA-256 исходного `dist/gifenc.esm.js`:
  `217761244379253ba5815510d3048a4fb1f4c4dbe9fb51a5cfbfe26f34eec093`
- Лицензия MIT:

```text
The MIT License (MIT)

Copyright (c) 2017 Matt DesLauriers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## omggif 1.0.10 (только devDependency, в поставку не входит)

Используется исключительно в тестах как независимый GIF-декодер:
`npm install` -> `node --test`. Автор Dean McNamee, лицензия MIT
(текст — в `node_modules/omggif/LICENSE` после установки).
