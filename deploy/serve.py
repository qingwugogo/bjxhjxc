#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
贴纸进销存 · 本机服务
============================================================
把应用页面（index.html / app.css / app.js）托管到本机
http://127.0.0.1:<端口>，双击桌面图标即可像桌面软件一样使用。

数据依然保存在 WorkBuddy 云服务上（联网、多设备同步），
本机只负责「把页面送到浏览器」，不存储任何业务数据。

服务由 macOS 的 launchd 托管（LaunchAgent）：
    · 独立于任何终端窗口，关掉终端也继续运行
    · 开机自动启动
    · 意外崩溃会被自动拉起
    · 只监听 127.0.0.1，不对局域网/外网暴露

常用命令
    python3 serve.py             启动服务并打开应用窗口（最常用）
    python3 serve.py open        只打开窗口（服务没在跑就先拉起来）
    python3 serve.py stop        停止服务
    python3 serve.py status      查看运行状态
    python3 serve.py install     安装：注册常驻服务 + 创建桌面图标
    python3 serve.py uninstall   完全卸载：停服务 + 删配置 + 删桌面图标
============================================================
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------- 常量

APP_NAME = '贴纸进销存'
APP_TAG = 'sticker-inventory'
LAUNCH_LABEL = 'com.sticker.inventory.server'
HOST = '127.0.0.1'                     # 只监听本机，不对局域网/外网暴露
PORT_START = 8765
PORT_TRIES = 40

DEPLOY_DIR = Path(__file__).resolve().parent
APP_DIR = DEPLOY_DIR.parent            # 含 index.html 的应用目录
RUNTIME_DIR = DEPLOY_DIR / 'runtime'
PID_FILE = RUNTIME_DIR / 'server.pid'
PORT_FILE = RUNTIME_DIR / 'server.port'
LOG_FILE = RUNTIME_DIR / 'server.log'
LAUNCH_LOG = RUNTIME_DIR / 'launchd.log'
PLIST_PATH = Path.home() / 'Library' / 'LaunchAgents' / (LAUNCH_LABEL + '.plist')

DESKTOP = Path.home() / 'Desktop'
APP_BUNDLE = DESKTOP / (APP_NAME + '.app')
STOP_BUNDLE = DESKTOP / ('停止' + APP_NAME + '.app')

BROWSER_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

PYTHON = sys.executable


# ---------------------------------------------------------------- 基础工具

def log(msg: str) -> None:
    line = '%s  %s' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 2 * 1024 * 1024:
            LOG_FILE.write_text('', encoding='utf-8')
        with LOG_FILE.open('a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


def find_free_port(start: int = PORT_START) -> int:
    for p in range(start, start + PORT_TRIES):
        if port_free(p):
            return p
    raise RuntimeError('从 %d 起的 %d 个端口都被占用了，请用 --port 指定其他端口' % (start, PORT_TRIES))


def ping(port: int, timeout: float = 0.8):
    """探测端口上是否运行着本应用的服务；是则返回其状态信息。"""
    try:
        with urllib.request.urlopen('http://%s:%d/__app_ping' % (HOST, port), timeout=timeout) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('app') == APP_TAG:
                return data
    except Exception:
        pass
    return None


def running_server():
    """返回当前正在运行的服务信息（端口 / pid），没有则 None。"""
    if PORT_FILE.exists():
        try:
            port = int(PORT_FILE.read_text().strip())
        except ValueError:
            port = None
        if port:
            info = ping(port)
            if info:
                return info
    for port in range(PORT_START, PORT_START + PORT_TRIES):
        info = ping(port, timeout=0.15)
        if info:
            return info
    return None


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def open_window(port: int, use_app_mode: bool = True) -> None:
    """打开应用窗口：优先浏览器的应用模式（无地址栏，观感像独立软件）。"""
    url = 'http://%s:%d/' % (HOST, port)
    if use_app_mode:
        for exe in BROWSER_CANDIDATES:
            if os.path.exists(exe):
                subprocess.Popen(
                    [exe, '--app=' + url, '--window-size=1380,920',
                     '--no-first-run', '--no-default-browser-check'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                return
    subprocess.Popen(['open', url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------- launchd

def _launchctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['launchctl', *args], capture_output=True, text=True, timeout=30)


def _domain() -> str:
    return 'gui/%d' % os.getuid()


def plist_xml() -> bytes:
    payload = {
        'Label': LAUNCH_LABEL,
        'ProgramArguments': [PYTHON, str(DEPLOY_DIR / 'serve.py'), 'start', '--no-open'],
        'WorkingDirectory': str(DEPLOY_DIR),
        'RunAtLoad': True,
        # 只在「异常退出」时自动拉起；用户主动停止（正常退出）不会复活
        'KeepAlive': {'SuccessfulExit': False},
        'StandardOutPath': str(LAUNCH_LOG),
        'StandardErrorPath': str(LAUNCH_LOG),
        'ProcessType': 'Background',
    }
    return plistlib.dumps(payload)


def launchd_installed() -> bool:
    return PLIST_PATH.exists()


def launchd_running() -> bool:
    r = _launchctl('print', '%s/%s' % (_domain(), LAUNCH_LABEL))
    return r.returncode == 0


def launchd_bootstrap() -> bool:
    """把服务交给 launchd 托管（已加载则重启它）。"""
    if not launchd_installed():
        return False
    if launchd_running():
        _launchctl('kickstart', '-k', '%s/%s' % (_domain(), LAUNCH_LABEL))
        return True
    r = _launchctl('bootstrap', _domain(), str(PLIST_PATH))
    if r.returncode != 0:
        # 兼容较老的 macOS
        r = _launchctl('load', '-w', str(PLIST_PATH))
    return r.returncode == 0


def launchd_bootout() -> bool:
    r = _launchctl('bootout', '%s/%s' % (_domain(), LAUNCH_LABEL))
    if r.returncode != 0:
        r = _launchctl('unload', '-w', str(PLIST_PATH))
    return r.returncode == 0


def wait_until_up(timeout: float = 12.0):
    """等端口就绪，返回服务信息。"""
    end = time.time() + timeout
    while time.time() < end:
        if PORT_FILE.exists():
            try:
                info = ping(int(PORT_FILE.read_text().strip()), timeout=0.5)
                if info:
                    return info
            except ValueError:
                pass
        info = ping(PORT_START, timeout=0.3)
        if info:
            return info
        time.sleep(0.25)
    return None


def ensure_running(spawn_foreground_fallback: bool = True):
    """确保服务在跑：优先交给 launchd，退化方案是直接拉起。"""
    info = running_server()
    if info:
        return info

    if launchd_installed() and launchd_bootstrap():
        info = wait_until_up()
        if info:
            return info

    if not spawn_foreground_fallback:
        return None

    # launchd 不可用（例如未安装桌面图标）时的兜底：独立会话后台进程
    port = find_free_port()
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with LAUNCH_LOG.open('a', encoding='utf-8') as out:
        subprocess.Popen(
            [PYTHON, str(DEPLOY_DIR / 'serve.py'), 'start', '--no-open', '--port', str(port)],
            stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            cwd=str(DEPLOY_DIR), start_new_session=True,
        )
    return wait_until_up()


# ---------------------------------------------------------------- HTTP

class AppHandler(SimpleHTTPRequestHandler):
    """静态文件服务，外加两个小改造：自检接口 + 禁用浏览器缓存。"""

    server_version = 'StickerInventory/1.0'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    @staticmethod
    def _blocked(path: str) -> bool:
        """不允许访问任何以「.」开头的隐藏目录（.workbuddy / .git / runtime 等）。"""
        clean = path.split('?')[0].split('#')[0]
        return any(seg.startswith('.') for seg in clean.split('/') if seg)

    def do_GET(self):  # noqa: N802
        if self.path.split('?')[0] == '/__app_ping':
            self._send_json({
                'app': APP_TAG,
                'name': APP_NAME,
                'port': self.server.server_address[1],
                'pid': os.getpid(),
                'dir': str(APP_DIR),
            })
            return
        if self._blocked(self.path):
            self.send_error(403, 'Forbidden')
            return
        super().do_GET()

    def do_HEAD(self):  # noqa: N802
        if self._blocked(self.path):
            self.send_error(403, 'Forbidden')
            return
        super().do_HEAD()

    def _send_json(self, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if self.path.split('?')[0] != '/__app_ping':
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        text = fmt % args
        if '__app_ping' in text:
            return
        log('HTTP  %s' % text)


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


# ---------------------------------------------------------------- 子命令

def cmd_start(args) -> int:
    """前台运行服务（通常由 launchd 调用）。"""
    info = running_server()
    if info:
        log('已有实例在运行（端口 %s），本次启动跳过' % info['port'])
        if not args.no_open:
            open_window(info['port'], not args.default_browser)
        return 0

    port = args.port or find_free_port()
    if not port_free(port):
        log('端口 %d 被占用，启动失败' % port)
        return 1

    httpd = Server((HOST, port), AppHandler)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding='utf-8')
    PORT_FILE.write_text(str(port), encoding='utf-8')
    log('服务启动  pid=%d  port=%d  根目录=%s' % (os.getpid(), port, APP_DIR))

    def on_signal(signum, _frame):
        log('收到信号 %s，准备退出' % signum)
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    if not args.no_open:
        threading.Timer(0.4, lambda: open_window(port, not args.default_browser)).start()

    print('%s 已启动：http://%s:%d/' % (APP_NAME, HOST, port), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        PID_FILE.unlink(missing_ok=True)
        PORT_FILE.unlink(missing_ok=True)
        log('服务已停止')
    return 0


def cmd_open(args) -> int:
    """打开应用窗口；服务没在跑就先拉起来。"""
    info = ensure_running()
    if not info:
        print('启动失败，请查看日志：%s' % LOG_FILE)
        return 1
    if not args.no_open:
        open_window(info['port'], not args.default_browser)
    print('已打开：http://%s:%s/' % (HOST, info['port']))
    return 0


def cmd_stop(_args) -> int:
    stopped = False
    if launchd_installed():
        stopped = launchd_bootout()
    info = running_server()
    if info:
        try:
            os.kill(int(info['pid']), signal.SIGTERM)
        except OSError:
            pass
        for _ in range(40):
            if not pid_alive(int(info['pid'])):
                break
            time.sleep(0.1)
        stopped = True
    PID_FILE.unlink(missing_ok=True)
    PORT_FILE.unlink(missing_ok=True)
    print('服务已停止' if stopped else '服务当前没有在运行')
    return 0


def cmd_status(_args) -> int:
    info = running_server()
    print('运行状态：%s' % ('运行中' if info else '未运行'))
    if info:
        print('  地址：http://%s:%s/' % (HOST, info['port']))
        print('  进程：%s' % info['pid'])
        print('  目录：%s' % info['dir'])
    print('开机自启：%s' % ('已开启' if launchd_installed() else '未配置'))
    print('桌面图标：%s' % ('已安装' if APP_BUNDLE.exists() else '未安装'))
    return 0 if info else 1


# ---------------------------------------------------------------- 桌面图标

ICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="1024" height="1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#4338ca"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/>
<circle cx="32" cy="32" r="15" fill="#ffffff"/>
<circle cx="32" cy="32" r="5.5" fill="#4f46e5"/>
</svg>
"""

LAUNCHER_TMPL = """#!/bin/bash
# {name} —— 双击后由本机服务打开应用窗口
PY="{python}"
SCRIPT="{script}"
LOG="{log}"
mkdir -p "$(dirname "$LOG")"
if [ ! -x "$PY" ]; then PY="/usr/bin/python3"; fi
"$PY" "$SCRIPT" {action} >>"$LOG" 2>&1
exit 0
"""

INFO_PLIST_TMPL = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>{name}</string>
  <key>CFBundleDisplayName</key><string>{name}</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>{bundle_id}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>10.14</string>
  <key>LSUIElement</key><{ui_element}/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"""


def make_icon(workdir: Path):
    """把网站图标转成 macOS 的 .icns；任何一步失败就返回 None（用系统默认图标）。"""
    chrome = next((p for p in BROWSER_CANDIDATES if os.path.exists(p)), None)
    if not chrome:
        return None
    try:
        svg = workdir / 'icon.svg'
        svg.write_text(ICON_SVG, encoding='utf-8')
        png = workdir / 'icon.png'
        subprocess.run(
            [chrome, '--headless=new', '--disable-gpu', '--hide-scrollbars',
             '--default-background-color=00000000',
             '--screenshot=' + str(png), '--window-size=1024,1024',
             'file://' + str(svg)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False,
        )
        if not png.exists() or png.stat().st_size < 500:
            return None
        iconset = workdir / 'icon.iconset'
        iconset.mkdir(exist_ok=True)
        for size in (16, 32, 64, 128, 256, 512):
            subprocess.run(['sips', '-z', str(size), str(size), str(png),
                            '--out', str(iconset / ('icon_%dx%d.png' % (size, size)))],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            subprocess.run(['sips', '-z', str(size * 2), str(size * 2), str(png),
                            '--out', str(iconset / ('icon_%dx%d@2x.png' % (size, size)))],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        icns = workdir / 'icon.icns'
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(icns)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        return icns if icns.exists() and icns.stat().st_size > 1000 else None
    except Exception:
        return None


def build_bundle(target: Path, name: str, bundle_id: str, action: str, icns, ui_element: str = 'false') -> None:
    if target.exists():
        shutil.rmtree(target)
    macos_dir = target / 'Contents' / 'MacOS'
    res_dir = target / 'Contents' / 'Resources'
    macos_dir.mkdir(parents=True)
    res_dir.mkdir(parents=True)

    (target / 'Contents' / 'Info.plist').write_text(
        INFO_PLIST_TMPL.format(name=name, bundle_id=bundle_id, ui_element=ui_element),
        encoding='utf-8')

    launcher = macos_dir / 'launcher'
    launcher.write_text(
        LAUNCHER_TMPL.format(name=name, python=PYTHON, script=str(DEPLOY_DIR / 'serve.py'),
                             log=str(RUNTIME_DIR / 'launch.log'), action=action),
        encoding='utf-8')
    launcher.chmod(0o755)

    if icns and Path(icns).exists():
        shutil.copy2(icns, res_dir / 'icon.icns')

    subprocess.run(['touch', str(target)], check=False)


def cmd_install(args) -> int:
    DESKTOP.mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)

    # 1) 注册为 launchd 常驻服务（开机自启）
    PLIST_PATH.write_bytes(plist_xml())
    loaded = launchd_bootstrap()
    print('常驻服务：%s' % ('已注册（开机自启）' if loaded else '配置已写入，但本次加载失败'))
    print('  配置文件：%s' % PLIST_PATH)

    # 2) 桌面图标
    workdir = RUNTIME_DIR / 'icon-build'
    workdir.mkdir(parents=True, exist_ok=True)
    icns = None if args.no_icon else make_icon(workdir)
    print('图标：%s' % ('已生成' if icns else '使用系统默认图标'))
    build_bundle(APP_BUNDLE, APP_NAME, 'com.sticker.inventory.launcher', 'open', icns)
    build_bundle(STOP_BUNDLE, '停止' + APP_NAME, 'com.sticker.inventory.stop', 'stop', icns,
                 ui_element='true')  # 停止器不在 Dock 里留图标
    print('桌面图标：')
    print('  %s' % APP_BUNDLE)
    print('  %s' % STOP_BUNDLE)

    # 3) 拉起并自检
    info = ensure_running()
    if info:
        print('服务已在运行：http://%s:%s/' % (HOST, info['port']))
    else:
        print('服务暂未起来，请查看日志：%s' % LOG_FILE)
    return 0


def cmd_uninstall(_args) -> int:
    if launchd_installed():
        launchd_bootout()
        PLIST_PATH.unlink(missing_ok=True)
        print('已移除常驻服务配置')
    info = running_server()
    if info:
        try:
            os.kill(int(info['pid']), signal.SIGTERM)
        except OSError:
            pass
        print('已停止服务')
    for target in (APP_BUNDLE, STOP_BUNDLE):
        if target.exists():
            shutil.rmtree(target)
            print('已移除 %s' % target)
    PID_FILE.unlink(missing_ok=True)
    PORT_FILE.unlink(missing_ok=True)
    return 0


# ---------------------------------------------------------------- 入口

def main() -> int:
    parser = argparse.ArgumentParser(
        description='%s 本机服务' % APP_NAME,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='不带子命令等价于 open。')
    parser.add_argument('command', nargs='?', default='open',
                        choices=['start', 'open', 'stop', 'status', 'install', 'uninstall'])
    parser.add_argument('--port', type=int, help='指定端口（默认自动从 %d 开始找空闲端口）' % PORT_START)
    parser.add_argument('--no-open', action='store_true', help='不要自动打开窗口')
    parser.add_argument('--default-browser', action='store_true', help='用系统默认浏览器打开（带地址栏）')
    parser.add_argument('--no-icon', action='store_true', help='install 时不生成图标')
    args = parser.parse_args()

    table = {
        'start': cmd_start,
        'open': cmd_open,
        'stop': cmd_stop,
        'status': cmd_status,
        'install': cmd_install,
        'uninstall': cmd_uninstall,
    }
    return table[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
