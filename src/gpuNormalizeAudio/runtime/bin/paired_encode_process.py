import os
import subprocess
import sys


def _split_encode_command(command):
    if not command or str(command[0]).startswith('__'):
        return None
    try:
        input_index = command.index('-i')
        format_index = command.index('-f')
    except ValueError:
        return None
    if input_index + 1 >= len(command) or command[input_index + 1] != 'pipe:0':
        return None
    if format_index >= input_index:
        return None
    return command[:format_index], command[format_index:input_index + 2], command[input_index + 2:]


def _is_subsequence(shorter, longer):
    iterator = iter(longer)
    return all(any(value == candidate for candidate in iterator) for value in shorter)


def build_paired_encode_command(primary_command, partner_command, read_fds):
    primary = _split_encode_command(primary_command)
    partner = _split_encode_command(partner_command)
    if primary is None or partner is None or primary_command[0] != partner_command[0]:
        return None

    primary_common, primary_input, primary_output = primary
    partner_common, partner_input, partner_output = partner
    if _is_subsequence(primary_common, partner_common):
        common = partner_common
    elif _is_subsequence(partner_common, primary_common):
        common = primary_common
    else:
        return None

    command = list(common)
    for index, (input_args, output_args, read_fd) in enumerate((
        (primary_input, primary_output, read_fds[0]),
        (partner_input, partner_output, read_fds[1]),
    )):
        input_args = list(input_args)
        input_args[-1] = f'pipe:{read_fd}'
        command.extend(input_args)
        command.extend(('-map', f'{index}:a:0'))
        command.extend(output_args)
    return command


class PairedEncodeProcess:
    def __init__(self, proc, read_fds, write_fds):
        self.proc = proc
        self.read_fds = read_fds
        self.write_fds = write_fds

    @classmethod
    def start(cls, primary_command, partner_command):
        pipes = (os.pipe(), os.pipe())
        read_fds = tuple(pipe[0] for pipe in pipes)
        write_fds = tuple(pipe[1] for pipe in pipes)
        command = build_paired_encode_command(primary_command, partner_command, read_fds)
        if command is None:
            for fd in read_fds + write_fds:
                os.close(fd)
            return None
        try:
            proc = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=sys.stderr,
                pass_fds=read_fds,
            )
        except BaseException:
            for fd in read_fds + write_fds:
                os.close(fd)
            raise
        for fd in read_fds:
            os.close(fd)
        return cls(proc, (), write_fds)

    def encode_commands(self):
        return tuple(('__loudnorm_open_fd_write__', str(fd), self) for fd in self.write_fds)

    def open_write_fd(self, fd):
        if fd not in self.write_fds:
            raise RuntimeError('paired encode write fd is not available')
        self.write_fds = tuple(candidate for candidate in self.write_fds if candidate != fd)
        return os.fdopen(fd, 'wb', buffering=0)

    def _close_fds(self):
        for fd in self.read_fds + self.write_fds:
            try:
                os.close(fd)
            except OSError:
                pass
        self.read_fds = ()
        self.write_fds = ()

    def wait(self):
        self._close_fds()
        code = self.proc.wait()
        if code != 0:
            raise RuntimeError(f'paired encode failed with exit code {code}')

    def abort(self):
        self._close_fds()
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
