const { spawn, exec } = require("child_process");

module.exports = function (RED) {
    RED.httpAdmin.post("/wsl-ubuntu/:id/kill", function(req, res) {
        const targetNode = RED.nodes.getNode(req.params.id);
        if (targetNode) {
            try {
                targetNode.killProcess();
                res.sendStatus(200);
            } catch (e) {
                res.status(500).send(`Error: ${e.message}`);
            }
        } else {
            res.sendStatus(404);
        }
    });

    function WslUbuntuNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        let distro = "Ubuntu-20.04";
        let wslConfigNode = null;
        if (config.wslconfig) {
            wslConfigNode = RED.nodes.getNode(config.wslconfig);
            if (wslConfigNode && wslConfigNode.distro) {
                distro = wslConfigNode.distro;
            }
        } else if (config.distro) {
            distro = config.distro;
        }
        const continuous = config.continuous || false;
        const sudoPassword = this.credentials.sudoPassword || "";
        const initCmd = config.initCmd || "";
        // Ubuntu's ~/.bashrc returns immediately when the shell is not interactive,
        // so a plain "bash -l -c" starts with an environment a real terminal never
        // has (no ROS setup.bash, no aliases or PATH additions from ~/.bashrc).
        // A login *interactive* shell reproduces what opening a WSL terminal does.
        const loadProfile = config.loadProfile !== false;
        // MOTD_SHOWN stops /etc/profile.d/update-motd.sh from printing the daily
        // "Welcome to Ubuntu" banner into the command output; +H disables history
        // expansion, which an interactive shell would otherwise apply to "!" in commands.
        const loginShell = loadProfile
            ? "env MOTD_SHOWN=1 bash +H -l -i -c"
            : "bash -l -c";

        // An interactive shell without a tty writes these to stderr; they are not
        // command output and must not be reported as errors.
        const shellNoise = [
            /^logout$/,
            /^bash: cannot set terminal process group \(-?\d+\): .*$/,
            /^bash: no job control in this shell$/
        ];

        function stripShellNoise(text) {
            if (!loadProfile) return text;
            return text
                .split("\n")
                .filter(line => !shellNoise.some(re => re.test(line.replace(/\r$/, ""))))
                .join("\n");
        }

        // Single-quote the command for the shell, so that $VAR, backticks and
        // quotes are expanded by the shell that has the profile loaded rather
        // than by the outer wrapper shell, which knows nothing of ~/.bashrc.
        function shQuote(str) {
            return "'" + str.split("'").join("'\\''") + "'";
        }

        let activeProcess = null;
        let currentCommand = "";
        let isKilling = false;
        let processHasOutput = false;
        let processGroupId = null;

        function showProvisionStatus(status) {
            switch (status) {
                case "checking":
                    node.status({ fill: "grey", shape: "ring", text: "Checking WSL..." });
                    break;
                case "starting":
                    node.status({ fill: "blue", shape: "ring", text: "Preparing environment..." });
                    break;
                case "importing":
                    node.status({ fill: "blue", shape: "ring", text: "Importing..." });
                    break;
                case "error":
                    node.status({ fill: "red", shape: "dot", text: "WSL setup failed" });
                    break;
                default:
                    node.status({ fill: "green", shape: "dot", text: "Standby" });
            }
        }

        if (wslConfigNode && wslConfigNode.provisionStatus) {
            showProvisionStatus(wslConfigNode.provisionStatus);
            const onProvision = function (evt) {
                if (!activeProcess && !isKilling) {
                    showProvisionStatus(evt.status);
                }
            };
            wslConfigNode.on("wsl-provision", onProvision);
            node.on("close", function () {
                wslConfigNode.removeListener("wsl-provision", onProvision);
            });
        } else {
            node.status({ fill: "green", shape: "dot", text: "Standby" });
        }

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

            if (wslConfigNode && wslConfigNode.provisionStatus && wslConfigNode.provisionStatus !== "ready") {
                node.error('WSL environment "' + distro + '" is not ready (' + wslConfigNode.provisionStatus
                    + (wslConfigNode.provisionDetail ? ": " + wslConfigNode.provisionDetail : "") + ")", msg);
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
            
            const isSudo = command.startsWith("sudo") && sudoPassword.length > 0;
            const innerCommand = initCmdStr + (isSudo ? command.slice(5) : command);

            if (isSudo) {
                runCommand = `echo ${shQuote(sudoPassword)} | sudo -S ${loginShell} ${shQuote(innerCommand)}`;
            } else {
                runCommand = `${loginShell} ${shQuote(innerCommand)}`;
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
                const message = stripShellNoise(data.toString());
                if (!message.trim()) return;
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
                let closeDone = false;
                const finishClose = function () {
                    if (closeDone) return;
                    closeDone = true;
                    clearTimeout(safetyTimeout);
                    done();
                };

                node.status({ fill: "grey", shape: "dot", text: "Deploying..." });

                const savedCommand = currentCommand;

                node.killProcess(() => {
                    if (savedCommand) {
                        const escapedCmd = savedCommand.replace(/'/g, "\\'");
                        exec(`wsl.exe -d ${distro} -e bash -c "pgrep -f '${escapedCmd}' | xargs -r kill -9"`,
                            { windowsHide: true, timeout: 2000 },
                            () => finishClose()
                        );
                    } else {
                        finishClose();
                    }
                });

                const safetyTimeout = setTimeout(() => {
                    activeProcess = null;
                    finishClose();
                }, 5000);
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
