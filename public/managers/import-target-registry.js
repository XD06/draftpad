export class ImportTargetRegistry {
    constructor() {
        this.targets = new Map();
    }

    register(target) {
        if (!target?.id || typeof target.importText !== 'function') {
            throw new Error('An import target requires an id and importText handler');
        }
        this.targets.set(target.id, { ...target });
        return () => this.targets.delete(target.id);
    }

    list() {
        return [...this.targets.values()];
    }

    get(id) {
        return this.targets.get(id) || null;
    }

    async importText(id, text) {
        const target = this.get(id);
        if (!target) throw new Error('请选择保存位置');
        return target.importText(String(text || ''));
    }
}
