/**
 * What the Recipes module is called. With Food items readable it keeps the food wording; otherwise
 * the same records read as bills of materials made from materials, for generic production.
 */
export interface RecipeTerms {
  /** "Recipes" / "Bills of materials": page titles and the sidebar. */
  title: string;
  /** "Recipe" / "Bill of materials": a field label or one record. */
  one: string;
  /** "recipe" / "bill of materials": inside a sentence. */
  singular: string;
  /** "recipes" / "bills of materials": inside a sentence. */
  plural: string;
  /** "Ingredients" / "Materials": the lines of a version. */
  lines: string;
  /** "Ingredient" / "Material": a column heading for one line. */
  lineTitle: string;
  /** "ingredient" / "material": one line, inside a sentence. */
  line: string;
  /** "ingredients" / "materials": lines, inside a sentence. */
  linesLower: string;
}

const food: RecipeTerms = {
  title: "Recipes",
  one: "Recipe",
  singular: "recipe",
  plural: "recipes",
  lines: "Ingredients",
  lineTitle: "Ingredient",
  line: "ingredient",
  linesLower: "ingredients",
};

const generic: RecipeTerms = {
  title: "Bills of materials",
  one: "Bill of materials",
  singular: "bill of materials",
  plural: "bills of materials",
  lines: "Materials",
  lineTitle: "Material",
  line: "material",
  linesLower: "materials",
};

export const recipeTerms = (foodItems: boolean): RecipeTerms => (foodItems ? food : generic);
