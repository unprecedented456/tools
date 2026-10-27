"""Local document text extraction. Input/output are JSON over standard streams."""
import base64
import io
import json
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_TEXT = 500000


def extract(filename, data):
    ext = os.path.splitext(filename)[1].lower()
    warnings = []
    pages = None
    if ext in ('.txt', '.md', '.markdown'):
        encodings = ['utf-16'] if data.startswith((b'\xff\xfe', b'\xfe\xff')) else ['utf-8-sig', 'gb18030']
        text = None
        for encoding in encodings:
            try:
                text = data.decode(encoding)
                break
            except UnicodeError:
                continue
        if text is None:
            raise ValueError('文件文字编码无法识别，请另存为UTF-8')
    elif ext == '.docx':
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo('word/document.xml')
            if info.file_size > 12000000:
                raise ValueError('Word正文过大，请拆分文件')
            xml = archive.read(info)
            if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
                raise ValueError('Word正文格式不支持')
            root = ET.fromstring(xml)
            ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
            lines = []
            for paragraph in root.iter(ns + 'p'):
                pieces = []
                for node in paragraph.iter():
                    if node.tag == ns + 't':
                        pieces.append(node.text or '')
                    elif node.tag == ns + 'tab':
                        pieces.append('\t')
                    elif node.tag in (ns + 'br', ns + 'cr'):
                        pieces.append('\n')
                lines.append(''.join(pieces))
            text = '\n'.join(lines)
            if any(item.filename.startswith('word/media/') for item in archive.infolist()):
                warnings.append('只提取了文字，Word中的图片未识别')
    elif ext == '.pdf':
        try:
            from pypdf import PdfReader
        except ImportError as error:
            raise ValueError('本机缺少PDF文字解析器pypdf，请使用TXT或DOCX，或安装解析器后重试') from error
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(''):
            raise ValueError('PDF需要密码，请先另存为可阅读的文件')
        pages = len(reader.pages)
        if pages > 600:
            raise ValueError('PDF超过600页，请按章节拆分')
        texts = []
        empty = 0
        total = 0
        for index, page in enumerate(reader.pages):
            part = page.extract_text() or ''
            empty += not bool(part.strip())
            total += len(part)
            if total > MAX_TEXT:
                raise ValueError('文件正文超过50万字，请拆分后导入')
            texts.append(f'\n[第{index + 1}页]\n{part}' if part.strip() else '')
        text = '\n'.join(texts)
        if empty:
            warnings.append(f'{empty}页未提取到文字；扫描页、图片和公式可能需要先做OCR')
    elif ext == '.doc':
        raise ValueError('旧版.doc请先在Word中另存为.docx后导入')
    else:
        raise ValueError('支持MD、TXT、PDF和Word DOCX文件')
    text = text.replace('\x00', '').strip()
    if not text:
        raise ValueError('未提取到正文；扫描版PDF或图片型Word请先做OCR或转成文字')
    if len(text) > MAX_TEXT:
        raise ValueError('文件正文超过50万字，请拆分后导入')
    return {'text': text, 'format': ext.lstrip('.'), 'pages': pages, 'warnings': warnings}


if __name__ == '__main__':
    try:
        value = json.loads(sys.stdin.buffer.read().decode('utf-8'))
        data = base64.b64decode(value['data'], validate=True)
        if len(data) > 15000000:
            raise ValueError('文件超过15MB，请拆分后导入')
        result = extract(value['filename'], data)
        sys.stdout.buffer.write(json.dumps({'result': result}, ensure_ascii=False).encode('utf-8'))
    except ValueError as error:
        sys.stdout.buffer.write(json.dumps({'error': str(error)}, ensure_ascii=False).encode('utf-8'))
    except Exception:
        sys.stdout.buffer.write(json.dumps({'error': '文件解析失败，请检查文件是否完整，或另存为TXT、DOCX后重试'}, ensure_ascii=False).encode('utf-8'))
