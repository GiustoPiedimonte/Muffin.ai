import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic();
async function main() {
    try {
        const response = await anthropic.models.list();
        console.log(response.data.map((m: any) => m.id).filter((id: string) => id.includes("claude")));
    } catch (e) {
        console.error(e);
    }
}
main();
