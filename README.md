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

## Continuous Mode

When "Continuous" mode is enabled, command output is sent continuously as it becomes available. This is especially useful for long-running processes like `roscore` or other server applications.

In this mode:
- Output is streamed in real-time 
- A stop button appears in the node allowing you to terminate the process
- You can also terminate the process by sending a message with `msg.kill=true`

When "Continuous" mode is disabled, command output is sent as a single message after the command completes execution.

## Usage Examples

Different versions are shown for different Ubuntu environments.

![os.png](./image/os.png)

![os-output.png](./image/os-output.png)

You can also use apt-get to install and remove packages.  
For example, you can output the result of neofetch to System Console.  

![neofetch.png](./image/neofetch.png)

![neofetch-output.png](./image/neofetch-output.png)
