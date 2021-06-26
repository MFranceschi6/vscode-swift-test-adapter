
export enum Platform {
    linux = 'linux',
    mac = 'mac'
}

export function getPlatform(): Platform {
    switch (process.platform) {
        case 'darwin': return Platform.mac
        default: return Platform.linux
    }
} 