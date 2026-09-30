#!/usr/bin/env python3
"""Record real Toris PTY output and render it to README screenshots and MP4.

Tooling only: Python Pillow, pexpect, pyte and ffmpeg; no app dependencies.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('docs/assets/readme'))
    parser.add_argument('--python-deps', type=Path, help='Optional tool-only dependency directory')
    args = parser.parse_args()
    if args.python_deps:
        sys.path.insert(0, str(args.python_deps))
    import pexpect
    import pyte
    from PIL import Image, ImageDraw, ImageFont

    repo = Path(__file__).resolve().parent.parent
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cols, rows, cell_w, cell_h = 96, 38, 11, 22
    width, height = cols * cell_w + 64, rows * cell_h + 94
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 18)
    bold = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', 18)
    title_font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 15)
    palette = {'default': '#e5e7eb', 'black': '#0b1016', 'red': '#ef7780',
               'green': '#85dba7', 'brown': '#ebcb83', 'blue': '#8eb8ef',
               'magenta': '#c4a7e7', 'cyan': '#88cbd4', 'white': '#e5e7eb',
               'brightblack': '#7d8999', 'brightred': '#ff8992',
               'brightgreen': '#a0ecc0', 'brightbrown': '#f9dd94',
               'brightblue': '#a6caff', 'brightmagenta': '#d4bfff',
               'brightcyan': '#a8e0e8', 'brightwhite': '#ffffff'}

    def color(value, fallback):
        if value == 'default':
            return fallback
        return palette.get(value, '#' + value if len(value) == 6 else fallback)

    def render(screen):
        image = Image.new('RGB', (width, height), '#090e14')
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((12, 12, width - 12, height - 12), 12, fill='#111821', outline='#2b3645')
        draw.text((32, 28), 'toris  /  offline terminal walkthrough', font=title_font, fill='#aeb9c7')
        draw.text((width - 190, 28), '96 columns · PTY', font=title_font, fill='#8290a3')
        draw.line((32, 56, width - 32, 56), fill='#2b3645')
        for row in range(rows):
            for col in range(cols):
                cell = screen.buffer[row][col]
                if not cell.data or cell.data == ' ':
                    continue
                x, y = 32 + col * cell_w, 70 + row * cell_h
                foreground = color(cell.fg, '#e5e7eb')
                background = color(cell.bg, '#111821')
                if cell.reverse:
                    foreground, background = background, foreground
                if background != '#111821':
                    draw.rectangle((x, y, x + cell_w, y + cell_h), fill=background)
                draw.text((x, y), cell.data, font=bold if cell.bold else font, fill=foreground)
        if not screen.cursor.hidden:
            x, y = 32 + screen.cursor.x * cell_w, 70 + screen.cursor.y * cell_h
            draw.line((x, y + 19, x + cell_w - 1, y + 19), fill='#ff875f', width=2)
        return image

    screen = pyte.Screen(cols, rows)
    stream = pyte.Stream(screen)
    events = []
    started = time.monotonic()

    class Recorder:
        def write(self, text):
            events.append([round(time.monotonic() - started, 4), 'o', text])
            stream.feed(text)

        def flush(self):
            pass

    with tempfile.TemporaryDirectory(prefix='toris-terminal-record-') as temporary:
        temporary = Path(temporary)
        local_bin = temporary / 'bin'
        local_bin.mkdir()
        (local_bin / 'toris').symlink_to(repo / 'bin/toris.js')
        task_env = dict(os.environ)
        task_env.update({'PATH': str(local_bin) + os.pathsep + task_env['PATH'],
                         'TORIS_HOME': str(temporary / 'state'), 'TERM': 'xterm-256color',
                         'PS1': '$ ', 'PROMPT_COMMAND': ''})
        task_env.pop('NO_COLOR', None)
        child = pexpect.spawn('/bin/bash', ['--noprofile', '--norc'], cwd=str(repo),
                              env=task_env, encoding='utf-8', dimensions=(rows, cols), timeout=120)
        child.logfile_read = Recorder()

        def type_command(command):
            for character in command:
                child.send(character)
                time.sleep(0.018)
            child.sendline('')

        def tui_command(command, snapshot=None):
            type_command(command)
            child.expect(r'❯(?:\x1b\[[0-9;]*m)* ')
            if snapshot:
                render(screen).save(output / snapshot)
            time.sleep(1)

        child.expect(r'\$ ')
        type_command('toris init --solo')
        child.expect(r'\$ ')
        type_command('printf "\\033[2J\\033[H"')
        child.expect(r'\$ ')
        type_command('toris --offline')
        child.expect(r'❯(?:\x1b\[[0-9;]*m)* ')
        tui_command('/status', 'tui-workspace.png')
        tui_command('/plan add a health endpoint', 'tui-plan.png')
        tui_command('/check', 'tui-checks.png')
        tui_command('/receipt')
        tui_command('/help')
        type_command('/exit')
        child.expect(r'\$ ')
        type_command('exit')
        child.expect(pexpect.EOF)
        child.close()
        if child.exitstatus != 0:
            raise RuntimeError(f'Demo shell exited {child.exitstatus}')
        transcript = ''.join(event[2] for event in events)
        if 'FAIL' in transcript or 'error  ' in transcript or 'PASS' not in transcript:
            raise RuntimeError('Demo checks did not complete successfully')
        if '0 in' not in transcript or '0 turns' not in transcript:
            raise RuntimeError('Expected an offline session with no model turns')

        duration = events[-1][0] + 2
        header = {'version': 2, 'width': cols, 'height': rows, 'title': 'Toris solo developer offline walkthrough',
                  'env': {'TERM': 'xterm-256color'}, 'duration': round(duration, 3)}
        with (output / 'terminal-demo.cast').open('w') as file:
            file.write(json.dumps(header) + '\n')
            for event in events:
                file.write(json.dumps(event, ensure_ascii=False) + '\n')

        replay = pyte.Screen(cols, rows)
        replay_stream = pyte.Stream(replay)
        fps = 8
        cursor = 0
        process = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                                    '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', f'{width}x{height}',
                                    '-framerate', str(fps), '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'fast',
                                    '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                                    str(output / 'terminal-demo.mp4')], stdin=subprocess.PIPE)
        try:
            for frame in range(int(duration * fps) + 1):
                timestamp = frame / fps
                while cursor < len(events) and events[cursor][0] <= timestamp:
                    replay_stream.feed(events[cursor][2])
                    cursor += 1
                process.stdin.write(render(replay).tobytes())
        finally:
            process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError('Video encoder failed')
        Image.open(output / 'tui-workspace.png').save(output / 'terminal-demo-poster.webp', quality=90)
        print(json.dumps({'duration': round(duration, 3), 'events': len(events), 'width': width,
                          'height': height, 'modelTurns': 0, 'shellExitCode': child.exitstatus,
                          'output': str(output)}))


if __name__ == '__main__':
    main()
