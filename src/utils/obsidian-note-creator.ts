import { generateFrontmatter as generateFrontmatterCore } from './shared';
import { Property } from '../types/types';
import { generalSettings } from './storage-utils';

export async function generateFrontmatter(properties: Property[]): Promise<string> {
	const typeMap: Record<string, string> = {};
	for (const pt of generalSettings.propertyTypes) {
		typeMap[pt.name] = pt.type;
	}
	return generateFrontmatterCore(properties, typeMap);
}
