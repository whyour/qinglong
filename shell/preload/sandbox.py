import os
import sys
import builtins
from pathlib import Path

# Get the QL_DIR and data directory paths
ql_dir = os.environ.get('QL_DIR', os.path.join(os.path.dirname(__file__), '../..'))
data_dir = os.environ.get('QL_DATA_DIR', os.path.join(ql_dir, 'data'))

# Normalize paths to avoid bypassing with relative paths or symlinks
try:
    normalized_ql_dir = os.path.realpath(ql_dir)
    normalized_data_dir = os.path.realpath(data_dir)
except:
    normalized_ql_dir = os.path.abspath(ql_dir)
    normalized_data_dir = os.path.abspath(data_dir)

# Protected directories - no write access allowed
protected_paths = [
    os.path.join(normalized_ql_dir, 'back'),
    os.path.join(normalized_ql_dir, 'src'),
    os.path.join(normalized_ql_dir, 'shell'),
    os.path.join(normalized_ql_dir, 'sample'),
    os.path.join(normalized_ql_dir, 'node_modules'),
    os.path.join(normalized_data_dir, 'config'),
    os.path.join(normalized_data_dir, 'db'),
]

# Allowed write directories - scripts can write here
allowed_write_paths = [
    os.path.join(normalized_data_dir, 'scripts'),
    os.path.join(normalized_data_dir, 'log'),
    os.path.join(normalized_data_dir, 'repo'),
    os.path.join(normalized_data_dir, 'raw'),
    os.path.join(normalized_ql_dir, '.tmp'),
    '/tmp',
]

# Check if sandboxing is enabled (default: true)
sandbox_enabled = os.environ.get('QL_DISABLE_SANDBOX') != 'true'

def is_path_protected(target_path):
    """Check if a path is protected from write operations"""
    if not sandbox_enabled:
        return False
    
    try:
        # Resolve to absolute path and follow symlinks
        resolved_path = os.path.realpath(target_path)
        
        # Check if path is in a protected directory
        for protected_path in protected_paths:
            if resolved_path.startswith(protected_path + os.sep) or resolved_path == protected_path:
                # Check if it's in an allowed subdirectory
                is_in_allowed_path = any(
                    resolved_path.startswith(allowed_path + os.sep) or resolved_path == allowed_path
                    for allowed_path in allowed_write_paths
                )
                
                if not is_in_allowed_path:
                    return True
        
        # Also check if trying to write inside ql_dir or data_dir without being in allowed paths
        is_in_ql_dir = resolved_path.startswith(normalized_ql_dir + os.sep) or resolved_path == normalized_ql_dir
        is_in_data_dir = resolved_path.startswith(normalized_data_dir + os.sep) or resolved_path == normalized_data_dir
        
        if is_in_ql_dir or is_in_data_dir:
            is_in_allowed_path = any(
                resolved_path.startswith(allowed_path + os.sep) or resolved_path == allowed_path
                for allowed_path in allowed_write_paths
            )
            
            if not is_in_allowed_path:
                return True
        
        return False
    except:
        # If path doesn't exist yet, check parent directory
        parent_path = os.path.dirname(target_path)
        if parent_path != target_path:
            return is_path_protected(parent_path)
        return False

def create_security_error(operation, target_path):
    """Create a security error for unauthorized file operations"""
    return PermissionError(
        f"Security Error: Script attempted to {operation} protected path: {target_path}\n"
        f"Scripts are only allowed to write to: {', '.join(allowed_write_paths)}"
    )

# Store original functions
original_open = builtins.open
original_os_remove = os.remove
original_os_unlink = os.unlink
original_os_rmdir = os.rmdir
original_os_mkdir = os.mkdir
original_os_makedirs = os.makedirs
original_os_rename = os.rename
original_os_replace = os.replace
original_os_chmod = os.chmod
original_os_chown = os.chown if hasattr(os, 'chown') else None
original_os_link = os.link if hasattr(os, 'link') else None
original_os_symlink = os.symlink if hasattr(os, 'symlink') else None
original_os_truncate = os.truncate if hasattr(os, 'truncate') else None
original_os_utime = os.utime if hasattr(os, 'utime') else None

# Wrap open() to check write operations
def sandboxed_open(file, mode='r', *args, **kwargs):
    """Wrapped open() that checks for protected paths on write operations"""
    if sandbox_enabled and isinstance(mode, str) and any(m in mode for m in ['w', 'a', 'x', '+']):
        if is_path_protected(file):
            raise create_security_error('open for writing', file)
    return original_open(file, mode, *args, **kwargs)

# Wrap os functions
def sandboxed_remove(path, *args, **kwargs):
    if sandbox_enabled and is_path_protected(path):
        raise create_security_error('remove', path)
    return original_os_remove(path, *args, **kwargs)

def sandboxed_unlink(path, *args, **kwargs):
    if sandbox_enabled and is_path_protected(path):
        raise create_security_error('unlink', path)
    return original_os_unlink(path, *args, **kwargs)

def sandboxed_rmdir(path, *args, **kwargs):
    if sandbox_enabled and is_path_protected(path):
        raise create_security_error('rmdir', path)
    return original_os_rmdir(path, *args, **kwargs)

def sandboxed_mkdir(path, *args, **kwargs):
    if sandbox_enabled and is_path_protected(path):
        raise create_security_error('mkdir', path)
    return original_os_mkdir(path, *args, **kwargs)

def sandboxed_makedirs(name, *args, **kwargs):
    if sandbox_enabled and is_path_protected(name):
        raise create_security_error('makedirs', name)
    return original_os_makedirs(name, *args, **kwargs)

def sandboxed_rename(src, dst, *args, **kwargs):
    if sandbox_enabled:
        if is_path_protected(src):
            raise create_security_error('rename (source)', src)
        if is_path_protected(dst):
            raise create_security_error('rename (destination)', dst)
    return original_os_rename(src, dst, *args, **kwargs)

def sandboxed_replace(src, dst, *args, **kwargs):
    if sandbox_enabled:
        if is_path_protected(src):
            raise create_security_error('replace (source)', src)
        if is_path_protected(dst):
            raise create_security_error('replace (destination)', dst)
    return original_os_replace(src, dst, *args, **kwargs)

def sandboxed_chmod(path, *args, **kwargs):
    if sandbox_enabled and is_path_protected(path):
        raise create_security_error('chmod', path)
    return original_os_chmod(path, *args, **kwargs)

def sandboxed_chown(path, *args, **kwargs):
    if sandbox_enabled and is_path_protected(path):
        raise create_security_error('chown', path)
    return original_os_chown(path, *args, **kwargs)

def sandboxed_link(src, dst, *args, **kwargs):
    if sandbox_enabled:
        if is_path_protected(dst):
            raise create_security_error('link', dst)
    return original_os_link(src, dst, *args, **kwargs)

def sandboxed_symlink(src, dst, *args, **kwargs):
    if sandbox_enabled:
        if is_path_protected(dst):
            raise create_security_error('symlink', dst)
    return original_os_symlink(src, dst, *args, **kwargs)

def sandboxed_truncate(path, *args, **kwargs):
    if sandbox_enabled and is_path_protected(path):
        raise create_security_error('truncate', path)
    return original_os_truncate(path, *args, **kwargs)

def sandboxed_utime(path, *args, **kwargs):
    if sandbox_enabled and is_path_protected(path):
        raise create_security_error('utime', path)
    return original_os_utime(path, *args, **kwargs)

# Apply sandbox wrappers
if sandbox_enabled:
    builtins.open = sandboxed_open
    os.remove = sandboxed_remove
    os.unlink = sandboxed_unlink
    os.rmdir = sandboxed_rmdir
    os.mkdir = sandboxed_mkdir
    os.makedirs = sandboxed_makedirs
    os.rename = sandboxed_rename
    os.replace = sandboxed_replace
    os.chmod = sandboxed_chmod
    if original_os_chown:
        os.chown = sandboxed_chown
    if original_os_link:
        os.link = sandboxed_link
    if original_os_symlink:
        os.symlink = sandboxed_symlink
    if original_os_truncate:
        os.truncate = sandboxed_truncate
    if original_os_utime:
        os.utime = sandboxed_utime

    # Wrap shutil if it's imported
    try:
        import shutil
        original_shutil_rmtree = shutil.rmtree
        original_shutil_copy = shutil.copy
        original_shutil_copy2 = shutil.copy2
        original_shutil_copytree = shutil.copytree
        original_shutil_move = shutil.move

        def sandboxed_rmtree(path, *args, **kwargs):
            if is_path_protected(path):
                raise create_security_error('rmtree', path)
            return original_shutil_rmtree(path, *args, **kwargs)

        def sandboxed_copy(src, dst, *args, **kwargs):
            if is_path_protected(dst):
                raise create_security_error('copy', dst)
            return original_shutil_copy(src, dst, *args, **kwargs)

        def sandboxed_copy2(src, dst, *args, **kwargs):
            if is_path_protected(dst):
                raise create_security_error('copy2', dst)
            return original_shutil_copy2(src, dst, *args, **kwargs)

        def sandboxed_copytree(src, dst, *args, **kwargs):
            if is_path_protected(dst):
                raise create_security_error('copytree', dst)
            return original_shutil_copytree(src, dst, *args, **kwargs)

        def sandboxed_move(src, dst, *args, **kwargs):
            if is_path_protected(src):
                raise create_security_error('move (source)', src)
            if is_path_protected(dst):
                raise create_security_error('move (destination)', dst)
            return original_shutil_move(src, dst, *args, **kwargs)

        shutil.rmtree = sandboxed_rmtree
        shutil.copy = sandboxed_copy
        shutil.copy2 = sandboxed_copy2
        shutil.copytree = sandboxed_copytree
        shutil.move = sandboxed_move
    except ImportError:
        pass

    # Wrap pathlib.Path if available
    try:
        original_path_write_text = Path.write_text
        original_path_write_bytes = Path.write_bytes
        original_path_touch = Path.touch
        original_path_mkdir = Path.mkdir
        original_path_rmdir = Path.rmdir
        original_path_unlink = Path.unlink
        original_path_rename = Path.rename
        original_path_replace = Path.replace
        original_path_chmod = Path.chmod

        def sandboxed_path_write_text(self, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.write_text', str(self))
            return original_path_write_text(self, *args, **kwargs)

        def sandboxed_path_write_bytes(self, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.write_bytes', str(self))
            return original_path_write_bytes(self, *args, **kwargs)

        def sandboxed_path_touch(self, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.touch', str(self))
            return original_path_touch(self, *args, **kwargs)

        def sandboxed_path_mkdir(self, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.mkdir', str(self))
            return original_path_mkdir(self, *args, **kwargs)

        def sandboxed_path_rmdir(self, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.rmdir', str(self))
            return original_path_rmdir(self, *args, **kwargs)

        def sandboxed_path_unlink(self, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.unlink', str(self))
            return original_path_unlink(self, *args, **kwargs)

        def sandboxed_path_rename(self, target, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.rename (source)', str(self))
            if is_path_protected(str(target)):
                raise create_security_error('Path.rename (target)', str(target))
            return original_path_rename(self, target, *args, **kwargs)

        def sandboxed_path_replace(self, target, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.replace (source)', str(self))
            if is_path_protected(str(target)):
                raise create_security_error('Path.replace (target)', str(target))
            return original_path_replace(self, target, *args, **kwargs)

        def sandboxed_path_chmod(self, *args, **kwargs):
            if is_path_protected(str(self)):
                raise create_security_error('Path.chmod', str(self))
            return original_path_chmod(self, *args, **kwargs)

        Path.write_text = sandboxed_path_write_text
        Path.write_bytes = sandboxed_path_write_bytes
        Path.touch = sandboxed_path_touch
        Path.mkdir = sandboxed_path_mkdir
        Path.rmdir = sandboxed_path_rmdir
        Path.unlink = sandboxed_path_unlink
        Path.rename = sandboxed_path_rename
        Path.replace = sandboxed_path_replace
        Path.chmod = sandboxed_path_chmod
    except:
        pass

    # Wrap subprocess to prevent sandbox bypass via subprocesses
    try:
        import subprocess
        
        # Helper to ensure PYTHONPATH is set for subprocesses
        def ensure_sandbox_env(env=None):
            if env is None:
                env = os.environ.copy()
            else:
                env = env.copy()
            
            # Ensure PYTHONPATH includes the sandbox directory
            sandbox_dir = os.path.dirname(__file__)
            if 'PYTHONPATH' not in env:
                env['PYTHONPATH'] = ''
            if sandbox_dir not in env['PYTHONPATH']:
                env['PYTHONPATH'] = f"{sandbox_dir}:{env['PYTHONPATH']}"
            
            return env
        
        # Store original functions
        original_popen = subprocess.Popen
        original_run = subprocess.run
        original_call = subprocess.call
        original_check_call = subprocess.check_call
        original_check_output = subprocess.check_output
        
        # Wrap Popen
        class SandboxedPopen(subprocess.Popen):
            def __init__(self, *args, **kwargs):
                if 'env' in kwargs:
                    kwargs['env'] = ensure_sandbox_env(kwargs['env'])
                else:
                    kwargs['env'] = ensure_sandbox_env()
                original_popen.__init__(self, *args, **kwargs)
        
        subprocess.Popen = SandboxedPopen
        
        # Wrap run
        def sandboxed_run(*args, **kwargs):
            if 'env' in kwargs:
                kwargs['env'] = ensure_sandbox_env(kwargs['env'])
            else:
                kwargs['env'] = ensure_sandbox_env()
            return original_run(*args, **kwargs)
        
        subprocess.run = sandboxed_run
        
        # Wrap call
        def sandboxed_call(*args, **kwargs):
            if 'env' in kwargs:
                kwargs['env'] = ensure_sandbox_env(kwargs['env'])
            else:
                kwargs['env'] = ensure_sandbox_env()
            return original_call(*args, **kwargs)
        
        subprocess.call = sandboxed_call
        
        # Wrap check_call
        def sandboxed_check_call(*args, **kwargs):
            if 'env' in kwargs:
                kwargs['env'] = ensure_sandbox_env(kwargs['env'])
            else:
                kwargs['env'] = ensure_sandbox_env()
            return original_check_call(*args, **kwargs)
        
        subprocess.check_call = sandboxed_check_call
        
        # Wrap check_output
        def sandboxed_check_output(*args, **kwargs):
            if 'env' in kwargs:
                kwargs['env'] = ensure_sandbox_env(kwargs['env'])
            else:
                kwargs['env'] = ensure_sandbox_env()
            return original_check_output(*args, **kwargs)
        
        subprocess.check_output = sandboxed_check_output
        
    except ImportError:
        pass

