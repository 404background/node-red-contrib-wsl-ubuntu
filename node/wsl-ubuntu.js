const { spawn } = require("child_process");

module.exports = function (RED) {
    function WslUbuntuNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const distro = config.distro || "Ubuntu-20.04";
        const continuous = config.continuous || false;
        const sudoPassword = this.credentials.sudoPassword || "";

        node.status({ fill: "green", shape: "dot", text: "Standby" });

        node.on("input", function (msg) {
            if (msg.kill === true) {
                node.status({ fill: "yellow", shape: "dot", text: "stopped" });
                return;
            }

            let command = msg.payload;
            if (!command) {
                node.error("No command provided", msg);
                return;
            }

            if (command.startsWith("sudo") && sudoPassword) {
                command = `echo ${sudoPassword} | sudo -S ${command.slice(5)}`;
            }

            let outputBuffer = "";
            const child = spawn(`wsl -d ${distro} --cd ~ -e bash -c "${command}"`, {
                shell: true,
            });
            node.status({ fill: "blue", shape: "dot", text: "Running" });

            child.stdout.on("data", (data) => {
                if (continuous) {
                    node.send({ payload: data.toString() });
                } else {
                    outputBuffer += data.toString();
                }
            });

            child.stderr.on("data", (data) => {
                const message = data.toString();
                if (!message.startsWith("[sudo]")) {
                    node.error(`Error: ${message}`, msg);
                }
            });
            
            child.on("error", (err) => {
                node.error("Failed to start process: " + err.message, msg);
                node.status({ fill: "red", shape: "dot", text: "Error" });
            });

            child.on("close", () => {
                if (!continuous) {
                    node.send({ payload: outputBuffer });
                }
                node.status({ fill: "green", shape: "dot", text: "Standby" });
            });
        });

        node.on("close", function () {
            node.status({ fill: "green", shape: "dot", text: "Standby" });
        });
    }

    RED.nodes.registerType("wsl-ubuntu", WslUbuntuNode, {
        credentials: {
            sudoPassword: {type: "password"}
        }
    });
};
