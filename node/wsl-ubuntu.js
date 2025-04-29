const { spawn, exec } = require("child_process");

module.exports = function (RED) {
    function WslUbuntuNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const distro = config.distro || "Ubuntu-20.04";
        const continuous = config.continuous || false;
        const sudoPassword = this.credentials.sudoPassword || "";
        const initCmd = config.initCmd || "";
        
        let activeProcess = null;
        let currentCommand = "";
        let isKilling = false;
        let processHasOutput = false;
        let processGroupId = null;
        
        node.status({ fill: "green", shape: "dot", text: "Standby" });

        RED.httpAdmin.post("/wsl-ubuntu/:id/kill", function(req, res) {
            const node = RED.nodes.getNode(req.params.id);
            if (node) {
                try {
                    node.killProcess();
                    res.sendStatus(200);
                } catch (e) {
                    res.status(500).send(`Error: ${e.message}`);
                }
            } else {
                res.sendStatus(404);
            }
        });
        
        function findWSLProcesses(callback) {
            if (!currentCommand) return callback([]);
            
            const escapedCmd = currentCommand.replace(/'/g, "\\'").replace(/"/g, '\\"');
            const findCmd = `wsl.exe -d ${distro} -e bash -c "ps -ef | grep -v grep | grep -F '${escapedCmd}' | awk '{print \\$2}'"`;
            
            exec(findCmd, { windowsHide: true }, (error, stdout, stderr) => {
                if (error || !stdout) return callback([]);
                
                const pids = stdout.toString().trim().split('\n').filter(pid => pid.length > 0);
                callback(pids);
            });
        }
        
        function findChildProcesses(parentPid, callback) {
            if (!parentPid) return callback([]);
            
            const findChildCmd = `wsl.exe -d ${distro} -e bash -c "ps -ef | grep -v grep | awk '\\\$3 == ${parentPid} {print \\\$2}'"`;
            
            exec(findChildCmd, { windowsHide: true }, (error, stdout, stderr) => {
                if (error || !stdout) return callback([]);
                
                const childPids = stdout.toString().trim().split('\n').filter(pid => pid.length > 0);
                callback(childPids);
            });
        }

        node.killProcess = function(callback) {
            if (isKilling) {
                if (callback) setTimeout(callback, 1000);
                return;
            }
            
            isKilling = true;
            node.status({ fill: "red", shape: "dot", text: "Terminating..." });
            
            let cleanupTasks = 0;
            let completedTasks = 0;
            
            function checkAllDone() {
                completedTasks++;
                if (completedTasks >= cleanupTasks) {
                    finishCleanup();
                }
            }
            
            function finishCleanup() {
                setTimeout(() => {
                    activeProcess = null;
                    currentCommand = "";
                    processGroupId = null;
                    isKilling = false;
                    processHasOutput = false;
                    
                    if (callback) {
                        node.status({ fill: "grey", shape: "dot", text: "Shutdown" });
                        callback();
                    } else {
                        node.status({ fill: "yellow", shape: "dot", text: "Stopped" });
                        setTimeout(() => {
                            if (!activeProcess && !isKilling) {
                                node.status({ fill: "green", shape: "dot", text: "Standby" });
                            }
                        }, 1000);
                    }
                }, 1000);
            }
            
            try {
                cleanupTasks = 3;
                
                if (activeProcess) {
                    if (activeProcess.stdout) {
                        activeProcess.stdout.removeAllListeners();
                        activeProcess.stdout.destroy();
                    }
                    if (activeProcess.stderr) {
                        activeProcess.stderr.removeAllListeners();
                        activeProcess.stderr.destroy();
                    }
                    activeProcess.removeAllListeners();
                    
                    try {
                        if (processGroupId) {
                            process.kill(-processGroupId, 'SIGINT');
                        }
                        activeProcess.kill('SIGINT');
                    } catch (e) {}
                    
                    setTimeout(() => {
                        try {
                            if (processGroupId) {
                                process.kill(-processGroupId, 'SIGTERM');
                            }
                            if (activeProcess) activeProcess.kill('SIGTERM');
                        } catch (e) {}
                        
                        setTimeout(() => {
                            try {
                                if (processGroupId) {
                                    process.kill(-processGroupId, 'SIGKILL');
                                }
                                if (activeProcess) activeProcess.kill('SIGKILL');
                            } catch (e) {}
                            checkAllDone();
                        }, 500);
                    }, 300);
                } else {
                    checkAllDone();
                }
                
                if (activeProcess && activeProcess.pid) {
                    exec(`taskkill /F /T /PID ${activeProcess.pid}`, { windowsHide: true, timeout: 1000 }, () => {
                        checkAllDone();
                    });
                } else {
                    checkAllDone();
                }
                
                findWSLProcesses((pids) => {
                    if (pids.length > 0) {
                        let allPids = [...pids];
                        let pendingChecks = pids.length;
                        
                        pids.forEach(pid => {
                            findChildProcesses(pid, (childPids) => {
                                if (childPids.length > 0) {
                                    allPids.push(...childPids);
                                }
                                
                                pendingChecks--;
                                if (pendingChecks <= 0) {
                                    allPids = [...new Set(allPids)];
                                    
                                    if (allPids.length > 0) {
                                        const termCmd = `wsl.exe -d ${distro} -e bash -c "kill -TERM ${allPids.join(' ')} 2>/dev/null || true"`;
                                        exec(termCmd, { windowsHide: true, timeout: 1000 }, () => {
                                            setTimeout(() => {
                                                const killCmd = `wsl.exe -d ${distro} -e bash -c "kill -KILL ${allPids.join(' ')} 2>/dev/null || true"`;
                                                exec(killCmd, { windowsHide: true, timeout: 1000 }, () => {
                                                    checkAllDone();
                                                });
                                            }, 1000);
                                        });
                                    } else {
                                        checkAllDone();
                                    }
                                }
                            });
                        });
                        
                        if (pendingChecks <= 0) {
                            checkAllDone();
                        }
                    } else {
                        checkAllDone();
                    }
                });
                
            } catch (error) {
                finishCleanup();
            }
        };

        node.on("input", function (msg) {
            if (msg.kill === true) {
                node.killProcess();
                return;
            }

            if (activeProcess || isKilling) {
                node.error("Process is already running or being terminated. Send msg.kill=true to terminate the current process.", msg);
                return;
            }

            let command = msg.payload;
            if (!command) {
                node.error("No command provided", msg);
                return;
            }

            currentCommand = command;
            let runCommand = "";
            
            const initCmdStr = initCmd ? `${initCmd} && ` : "";
            
            if (command.startsWith("sudo") && sudoPassword) {
                runCommand = `echo ${sudoPassword} | sudo -S bash -l -c "${initCmdStr}${command.slice(5).replace(/"/g, '\\"')}"`;
            } else {
                runCommand = `bash -l -c "${initCmdStr}${command.replace(/"/g, '\\"')}"`;
            }

            let outputBuffer = "";
            processHasOutput = false;
            
            let displayCmd = command;
            if (displayCmd.length > 30) {
                displayCmd = displayCmd.substring(0, 27) + "...";
            }
            node.status({ fill: "blue", shape: "dot", text: displayCmd });
            
            const spawnArgs = [
                "-d", distro,
                "--cd", "~",
                "-e", "bash", "-c", runCommand
            ];
            
            const spawnOptions = {
                windowsHide: true,
                detached: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false
            };
            
            const child = spawn("wsl.exe", spawnArgs, spawnOptions);
            
            activeProcess = child;
            processGroupId = child.pid;
            
            const heartbeatInterval = continuous ? setInterval(() => {
                if (activeProcess && !isKilling && !processHasOutput) {
                    node.status({ fill: "blue", shape: "dot", text: `Running: ${displayCmd} (No output)` });
                }
            }, 5000) : null;

            child.stdout.on("data", (data) => {
                const output = data.toString();
                processHasOutput = true;
                
                if (continuous) {
                    node.send({ payload: output });
                } else if (!isKilling) {
                    outputBuffer += output;
                }
            });

            child.stderr.on("data", (data) => {
                const message = data.toString();
                processHasOutput = true;
                
                if (continuous) {
                    node.send({ payload: message });
                } else if (!isKilling && !message.startsWith("[sudo]")) {
                    node.error(`Error: ${message}`, msg);
                }
            });
            
            child.on("error", (err) => {
                if (isKilling) return;
                
                node.error("Failed to start process: " + err.message, msg);
                node.status({ fill: "red", shape: "dot", text: "Error" });
                
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                }
                
                activeProcess = null;
                currentCommand = "";
                processHasOutput = false;
            });

            child.on("close", (code) => {
                if (isKilling) return;
                
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                }
                
                if (!continuous) {
                    node.send({ payload: outputBuffer });
                }
                
                if (code === 0) {
                    node.status({ fill: "green", shape: "dot", text: "Complete" });
                } else if (code !== null) {
                    node.status({ fill: "yellow", shape: "dot", text: `Exit: ${code}` });
                }
                
                activeProcess = null;
                currentCommand = "";
                processHasOutput = false;
                
                setTimeout(() => {
                    if (!activeProcess && !isKilling) {
                        node.status({ fill: "green", shape: "dot", text: "Standby" });
                    }
                }, 1000);
            });
        });

        node.on("close", function (done) {
            if (activeProcess) {
                node.status({ fill: "grey", shape: "dot", text: "Deploying..." });
                
                node.killProcess(() => {
                    exec(`wsl.exe -d ${distro} -e bash -c "pgrep -f '${currentCommand.replace(/'/g, "\\'")}' | xargs -r kill -9"`, 
                        { windowsHide: true, timeout: 2000 }, 
                        () => done()
                    );
                });
                
                const safetyTimeout = setTimeout(() => {
                    if (activeProcess) {
                        activeProcess = null;
                        done();
                    }
                }, 5000);
                
                safetyTimeout._onTimeout = function() {
                    clearTimeout(safetyTimeout);
                    if (activeProcess) {
                        done();
                    }
                };
            } else {
                done();
            }
        });
    }

    RED.nodes.registerType("wsl-ubuntu", WslUbuntuNode, {
        credentials: {
            sudoPassword: {type: "password"}
        }
    });
};
