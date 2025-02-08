const { spawn } = require("child_process");

module.exports = function (RED) {
    function WslUbuntuNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const distro = config.distro || "Ubuntu-20.04";
        node.status({ fill: "green", shape: "dot", text: "Standby" });

        node.on("input", function (msg) {
            if (msg.kill === true) {
                node.status({ fill: "yellow", shape: "dot", text: "stopped" });
                return;
            }

            const command = msg.payload || "cat /etc/os-release";
            node.status({ fill: "blue", shape: "dot", text: "Running" });

            const child = spawn("wsl", ["-d", distro, "-e", ...command.split(" ")]);

            let outputBuffer = "";

            child.stdout.on("data", (data) => {
                outputBuffer += data.toString();
            });

            child.stderr.on("data", (data) => {
                outputBuffer += data.toString();
            });

            child.on("close", () => {
                msg.payload = outputBuffer.trim();
                node.send(msg);
                node.status({ fill: "green", shape: "dot", text: "Standby" });
            });

            child.on("error", (err) => {
                node.error("Failed to start process: " + err.message, msg);
                node.status({ fill: "red", shape: "dot", text: "Error" });
            });
        });

        node.on("close", function () {
            node.status({ fill: "green", shape: "dot", text: "Standby" });
        });
    }

    RED.nodes.registerType("wsl-ubuntu", WslUbuntuNode);
};
