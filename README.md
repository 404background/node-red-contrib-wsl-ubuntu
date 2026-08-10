# node-red-contrib-wsl-ubuntu
Node for using Ubuntu environment in WSL with Node-RED

## Overview

This node can execute commands in the WSL Ubuntu environment.

![flows.png](./image/flows.png)

Therefore, **this node works only on Windows**.  
Please install the distribution using the wsl command in advance.  

The node can be set to the following options.  
- Ubuntu version
- Set the password when executing sudo (credential property)
- Whether the execution results are output sequentially or not

![edit.png](./image/edit.png)

## Shell Initialization

Commands run in a **login interactive shell**, so `/etc/profile` and `~/.bashrc` are
sourced exactly as they are when you open an Ubuntu terminal. Anything you appended to
`~/.bashrc` (for example `source /opt/ros/humble/setup.bash`) is therefore already in
effect, and environment variables such as `$ROS_DISTRO` resolve as expected.

This matters because Ubuntu's `~/.bashrc` returns immediately when the shell is not
interactive, so a plain non-interactive shell would silently skip all of it.

The behaviour is controlled by the **Shell Init** option, which is enabled by default.
The login banner (MOTD) is suppressed so that it never appears in the output. Disable the
option only if your `~/.bashrc` misbehaves when run this way; the node then falls back to
a non-interactive login shell.

The **Pre CMD** option is still available for commands that should run after the shell
startup files but before `msg.payload`, such as sourcing a workspace `devel/setup.bash`.

## What the Node Runs Internally

Knowing the exact command the node builds makes it much easier to reproduce a problem by
hand in a terminal.

### Starting a command

`wsl.exe` is spawned directly (no `cmd.exe` is involved):

```
wsl.exe -d <distro> --cd ~ -e bash -c "<wrapper command>"
```

| Part | Purpose |
| --- | --- |
| `-d <distro>` | The distribution selected in the WSL Config node |
| `--cd ~` | Start in the Linux home directory, not in the Node-RED working directory |
| `-e bash -c` | Run the wrapper without allocating a terminal |

There is no terminal attached: stdin is closed, and stdout / stderr are piped back to the
node. stdout becomes `msg.payload`, and stderr is reported with `node.error()` unless
"Continuous" mode is enabled.

The wrapper command that `bash -c` receives is:

```sh
env MOTD_SHOWN=1 bash +H -l -i -c '<Pre CMD> && <msg.payload>'
```

| Part | Purpose |
| --- | --- |
| `env MOTD_SHOWN=1` | Suppresses the daily "Welcome to Ubuntu" banner, which `/etc/profile.d/update-motd.sh` would otherwise print into the output |
| `-l` | Login shell, so `/etc/profile` and `/etc/profile.d/*.sh` are read |
| `-i` | Interactive shell, so `~/.bashrc` runs to the end instead of returning at its non-interactive guard |
| `+H` | Disables history expansion, which an interactive shell would otherwise apply to `!` inside a command |
| `'...'` | The command is single-quoted so that `$VAR`, backticks and quotes are expanded by this shell (which has the profile loaded), not by the outer wrapper shell |

`<Pre CMD> && ` is omitted when the Pre CMD field is empty. If "Shell Init" is disabled,
the inner shell is `bash -l -c '...'` instead, and `MOTD_SHOWN` and `+H` are not used.

The shell startup files are therefore read in the usual order:
`/etc/profile` → `/etc/profile.d/*.sh` → `~/.profile` → `~/.bashrc` (Ubuntu's `~/.profile`
sources `~/.bashrc` for bash).

### Commands starting with `sudo`

If `msg.payload` starts with `sudo` and a Sudo Pass credential is set, the password is fed
to `sudo -S` through a pipe and the leading `sudo` is removed from the command:

```sh
echo '<sudo password>' | sudo -S env MOTD_SHOWN=1 bash +H -l -i -c '<Pre CMD> && <rest of msg.payload>'
```

The shell therefore runs as root and reads root's startup files rather than yours. The
`[sudo] password for ...` prompt that `sudo -S` writes to stderr is filtered out of the
output. Note that the password appears in the command line of the wrapper process, so it is
briefly visible to `ps` inside the distribution.

### Stopping a command

Pressing the Stop button, sending `msg.kill=true`, or redeploying the flow runs a cleanup
sequence. On the Windows side the `wsl.exe` process is signalled `SIGINT` → `SIGTERM` →
`SIGKILL`, followed by:

```
taskkill /F /T /PID <pid of wsl.exe>
```

Killing `wsl.exe` does not necessarily stop the Linux process it started, so the node also
looks the process up inside the distribution and terminates it there:

```sh
ps -ef | grep -v grep | grep -F '<msg.payload>' | awk '{print $2}'   # the command itself
ps -ef | grep -v grep | awk '$3 == <pid> {print $2}'                 # its child processes
kill -TERM <pids>                                                    # then, after 1s:
kill -KILL <pids>
```

On redeploy, one final sweep runs so that nothing is left behind:

```sh
pgrep -f '<msg.payload>' | xargs -r kill -9
```

## Continuous Mode

When "Continuous" mode is enabled, command output is sent continuously as it becomes available. This is especially useful for long-running processes like `roscore` or other server applications.

In this mode:
- Output is streamed in real-time 
- A stop button appears in the node allowing you to terminate the process
- You can also terminate the process by sending a message with `msg.kill=true`

When "Continuous" mode is disabled, command output is sent as a single message after the command completes execution.

## Configuration Node (Managing Multiple Environments)

The **wsl-config** configuration node lets you manage several Ubuntu environments and select which one a `wsl-ubuntu` node runs against.

In the `wsl-ubuntu` node, choose a **WSL Config** to pick the target distribution. Each config node represents one environment, so you can keep multiple independent Ubuntu environments (for example one per project) side by side.

### Provisioning an environment

When a config node is created, you choose a **Source**:

- **Use existing distribution** – point at a distribution already installed. Installed distributions are detected automatically with `wsl -l -v`.
- **Import from local image file** – create a new distribution from a `.tar` / `.tar.gz` image on disk (`wsl --import <new name> <install location> <file>`).
- **Download & install clean Ubuntu** – download an official Ubuntu WSL `.tar.gz` image from the internet and import it. Only WSL-targeted releases are offered (currently **22.04** and **24.04**; Ubuntu 20.04 has no WSL image). The image is fetched for your host architecture (amd64/arm64) automatically.

For the import/download options you can configure the paths used for provisioning:

- **Image folder** – where the downloaded `.tar.gz` image file is saved. If set, the image is kept and reused for later imports; if empty, a temporary file is used and deleted after import.
- **Install to** – where the WSL environment (virtual disk) is created. Defaults to `<home>\wsl\<distro>` if empty. The folder is created automatically.

Provisioning runs automatically when the flow is **deployed** and the distribution is not installed yet. While it runs, `wsl-ubuntu` nodes using the config show the progress as their node status (**Downloading image...**, **Importing...**) and reject commands until the environment is ready. To build another environment, add another config node.

### Managing an environment

- **Export** – save the selected distribution to a `.tar` image file (`wsl --export <distro> <file>`). Useful for backing up or moving an environment between machines.
- **Unregister** – remove a distribution (`wsl --unregister`), with an optional prompt to delete its installation folder.
- **Deleting a config node** – when a config node whose source is import/download is deleted (and the change is deployed), the distribution it created is automatically removed with `wsl --unregister`. Config nodes that reference an existing distribution leave it untouched.

## Usage Examples

Different versions are shown for different Ubuntu environments.

![os.png](./image/os.png)

![os-output.png](./image/os-output.png)

You can also use apt-get to install and remove packages.  
For example, you can output the result of neofetch to System Console.  

![neofetch.png](./image/neofetch.png)

![neofetch-output.png](./image/neofetch-output.png)
