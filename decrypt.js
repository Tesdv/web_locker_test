const log = (msg) => {
    const el = document.getElementById('log');
    if (el) el.innerText = msg;
};

const fromHex = (hex) => new Uint8Array(
    hex.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || []
);

let decryptedZipArray = null;

async function nukeDecryptedState() {
    if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (let reg of registrations) {
            await reg.unregister().catch(() => {});
        }
    }
    decryptedZipArray = null;
    if ('caches' in window) {
        await caches.delete('ghost-vault').catch(() => {});
    }
}

// Nuke on every load (including refresh)
nukeDecryptedState();

async function unlock() {
    const password = document.getElementById('pass').value.trim();
    if (!password) return log("...");

    try {
        log("fetching metadata...");

        const res = await fetch('setup.ini');
        if (!res.ok) throw new Error("metadata missing");

        const buffer = await res.arrayBuffer();

        // Support both old and new format (GV02 or no magic)
        let offset = 0;
        if (new TextDecoder().decode(buffer.slice(0, 4)) === 'GV02') {
            offset = 4;
        }

        const salt = buffer.slice(offset, offset + 16);
        const nonce = buffer.slice(offset + 16, offset + 28);
        const view = new DataView(buffer);
        const iterations = view.getUint32(offset + 28, true);
        const encryptedMetadata = buffer.slice(offset + 32);

        log("deriving key...");

        const passBuffer = new TextEncoder().encode(password);
        const passKey = await crypto.subtle.importKey("raw", passBuffer, "PBKDF2", false, ["deriveBits"]);

        const masterKeyBytes = await crypto.subtle.deriveBits({
            name: "PBKDF2",
            salt: salt,
            iterations: iterations,
            hash: "SHA-256"
        }, passKey, 256);

        log("decrypting metadata...");

        const aesMaster = await crypto.subtle.importKey("raw", masterKeyBytes, "AES-GCM", false, ["decrypt"]);
        const metadataBuffer = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce },
            aesMaster,
            encryptedMetadata
        );

        const vaultData = JSON.parse(new TextDecoder().decode(metadataBuffer));
        const archiveMeta = vaultData.files["project_data.zip"];
        if (!archiveMeta) throw new Error("no archive");

        log("deriving file key...");

        const hkdfKey = await crypto.subtle.importKey("raw", masterKeyBytes, "HKDF", false, ["deriveBits"]);
        const fileKeyBytes = await crypto.subtle.deriveBits({
            name: "HKDF",
            hash: "SHA-256",
            salt: fromHex(archiveMeta.salt),
            info: new TextEncoder().encode("ghost_vault_file")
        }, hkdfKey, 256);

        const aesFile = await crypto.subtle.importKey("raw", fileKeyBytes, "AES-GCM", false, ["decrypt"]);

        log("decrypting chunks...");

        let chunks = [];
        for (let chunk of archiveMeta.chunks) {
            const chunkRes = await fetch(`project_data.zip/${chunk.chunk}`);
            if (!chunkRes.ok) throw new Error(`missing chunk ${chunk.chunk}`);

            const chunkBuffer = await chunkRes.arrayBuffer();
            const decryptedChunk = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: fromHex(chunk.nonce) },
                aesFile,
                chunkBuffer
            );
            chunks.push(new Uint8Array(decryptedChunk));
        }

        // Reassemble zip
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const zipArray = new Uint8Array(totalLength);
        let offsetPos = 0;
        for (let chunk of chunks) {
            zipArray.set(chunk, offsetPos);
            offsetPos += chunk.length;
        }

        decryptedZipArray = zipArray;

        log("activating vault...");

        await registerServiceWorker(zipArray);

        // Hide login and show site
        document.getElementById('login-box').style.display = 'none';
        const frame = document.getElementById('site-frame');
        frame.style.display = 'block';
        frame.src = './';

        // Show download link
        const blob = new Blob([zipArray], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const downloadBtn = document.getElementById('download-btn');
        downloadBtn.href = url;
        downloadBtn.style.display = 'block';

    } catch (e) {
        console.error(e);
        log("failed.");
    }
}

async function registerServiceWorker(zipArray) {
    await nukeDecryptedState();   // ensure clean state

    if (!('serviceWorker' in navigator)) {
        log("sw not supported");
        return;
    }

    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });

    const channel = new MessageChannel();

    reg.active.postMessage({
        type: 'INIT_VAULT',
        zipArray: zipArray
    }, [zipArray.buffer]);

    channel.port1.onmessage = (e) => {
        if (e.data.type === 'VAULT_READY') {
            console.log('vault ready');
        }
    };

    reg.active.postMessage({ type: 'CONNECT' }, [channel.port2]);
}